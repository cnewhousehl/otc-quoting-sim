// engine/rng.js
//
// Counter-based deterministic PRNG (Phase 1, Q1 + Q4 of PLAN.md).
//
// A draw is a PURE FUNCTION of its coordinates (seed, streamId, n, entityKey,
// localIdx) — there is no shared linear cursor. This is what guarantees the
// stream-isolation property the grader depends on (Q4): whether some unrelated
// quote/maker/draw exists has zero effect on any other coordinate's value,
// because nothing advances a shared counter.
//
// No Math.random(), no Date.now() — this is the single source of randomness for
// every engine module. Gaussians come from one uniform via the Acklam inverse
// normal CDF (exact 1 uniform -> 1 normal accounting).

// Q4 sub-stream registry, in canonical per-tick consumption order. Stream ids
// are stable integers folded into the hash, so adding a stream later never
// shifts the draws of an existing one.
export const STREAMS = Object.freeze({
  price: 1,
  jump: 2,
  book: 3,
  maker: 4,
  rfqArrival: 5,
  rfqSpec: 6,
  execHazard: 7,
  venueReact: 8,
  news: 9,
})

const U64 = (x) => BigInt.asUintN(64, x)
const GOLDEN = 0x9e3779b97f4a7c15n // 2^64 / golden ratio (splitmix64 gamma)
const TWO53 = 9007199254740992 // 2^53

// splitmix64 finalizer — strong avalanche mixing of a 64-bit word.
function fmix64(z) {
  z = U64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n)
  z = U64((z ^ (z >> 27n)) * 0x94d049bb133111ebn)
  return U64(z ^ (z >> 31n))
}

// Fold one coordinate into the running hash. Positional (order matters), so
// (stream, n, key, idx) address a unique cell of an infinite stream.
function combine(h, x) {
  return fmix64(U64(h + GOLDEN + U64(x)))
}

// Map an arbitrary entity key (string id like a quoteId/assetId/venueId, or a
// non-negative integer) to a 64-bit word. FNV-1a for strings.
function hashKey(key) {
  if (typeof key === 'number') return U64(BigInt(Math.trunc(key)))
  if (typeof key === 'bigint') return U64(key)
  const s = String(key)
  let h = 1469598103934665603n // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h = U64((h ^ BigInt(s.charCodeAt(i))) * 1099511628211n) // FNV prime
  }
  return h
}

// Core: (seed, stream, n, key, localIdx) -> 64-bit hash.
function hashCoords(seed64, stream, n, key, localIdx) {
  let h = seed64
  h = combine(h, BigInt(stream))
  h = combine(h, BigInt(n))
  h = combine(h, hashKey(key))
  h = combine(h, BigInt(localIdx))
  return h
}

// 64-bit hash -> double in [0, 1) using the top 53 bits.
function toUnit(h) {
  return Number(U64(h) >> 11n) / TWO53
}

// Acklam's algorithm for the inverse standard-normal CDF. One uniform p in
// (0,1) -> one standard normal. Relative error < 1.15e-9.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
]
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
]
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
  -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
]
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
  3.754408661907416e0,
]
const P_LOW = 0.02425
const P_HIGH = 1 - P_LOW

export function inverseNormalCDF(p) {
  // Clamp away from the open-interval endpoints so a uniform of exactly 0 (top
  // 53 bits all zero) can't produce ±Infinity.
  if (p <= 0) p = Number.EPSILON
  else if (p >= 1) p = 1 - Number.EPSILON

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    )
  }
  if (p <= P_HIGH) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
      (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
    ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
  )
}

// Bind a seed and return the per-coordinate draw functions used by every engine
// module:
//   rng.uniform(stream, n, key?, localIdx?) -> [0, 1)
//   rng.normal(stream, n, key?, localIdx?)  -> standard normal (mean 0, std 1)
// `stream` is a STREAMS.* id; `key` is a stable entity id (defaults 0);
// `localIdx` distinguishes multiple draws that share the same (stream, n, key).
export function createRng(seed) {
  // Mix the seed once so adjacent integer seeds (0,1,2…) decorrelate fully.
  const seed64 = fmix64(U64(BigInt(Math.trunc(seed)) ^ GOLDEN))
  return {
    seed,
    uniform(stream, n, key = 0, localIdx = 0) {
      return toUnit(hashCoords(seed64, stream, n, key, localIdx))
    },
    normal(stream, n, key = 0, localIdx = 0) {
      return inverseNormalCDF(toUnit(hashCoords(seed64, stream, n, key, localIdx)))
    },
  }
}
