// engine/toxicity.js
//
// Per-venue reaction to the student's signed flow (PLAN.md §1.1 toxicity.js, M7).
// A leaky EWMA of signed hedge flow per venue. When the student leans one way,
// the venue: widens its spread, thins the hit-side depth, and skews its mid away
// — and heals when the flow stops. ("Bids disappear when I smash the bid.")
//
// Phase 1b note: this becomes emergent from makers detecting adverse flow and
// pulling/widening (M11); here it's the parametric baseline. With zero
// sensitivities it is neutral (M3-equivalent).

export function createToxicity({ tau, dt, refFlow = 1, kSpread = 0, kDepth = 0, kSkew = 0 } = {}) {
  const decay = !tau || tau <= 0 ? 0 : Math.exp(-dt / tau)
  const ewma = new Map() // venueId -> signed-flow EWMA (size units)

  const get = (v) => ewma.get(v) ?? 0
  const norm = (v) => get(v) / refFlow // dimensionless lean

  function observe(venueId, signedSize) {
    ewma.set(venueId, get(venueId) + signedSize)
  }

  // Heal: decay every venue's lean toward 0.
  function decayAll() {
    for (const [k, val] of ewma) ewma.set(k, val * decay)
  }

  // Spread widens with the magnitude of the lean.
  function spreadMult(venueId) {
    return 1 + kSpread * Math.abs(norm(venueId))
  }

  // Mid skews away from the student's flow (signed).
  function skew(venueId) {
    return kSkew * norm(venueId)
  }

  // The side the student keeps hitting thins out. Buying (lean > 0) thins asks;
  // selling thins bids.
  function depthMult(venueId, side) {
    const n = norm(venueId)
    const thin = side === 'ask' ? Math.max(0, n) : Math.max(0, -n)
    return Math.max(0.05, 1 - kDepth * thin)
  }

  return { observe, decayAll, get, norm, spreadMult, skew, depthMult }
}
