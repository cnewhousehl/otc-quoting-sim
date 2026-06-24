// src/simConfig.js — the scenario the M4 visual harness drives.
// (Phase-1 config lives in /config from M9; this is a minimal standalone setup
// so the live book has something to breathe on before the full session exists.)

export const DT = 0.25 // sim tick = 250 ms
export const BOOK_RENDER_MS = 500 // ladder repaint throttle (introduced at M4)
export const LADDER_DEPTH = 8 // levels shown per side

export const ASSETS = [
  {
    id: 'BTC',
    m0: 65000,
    sigma: 0.0009, // per-tick return stdev → visibly drifting mid
    regime: 'flat',
    jumpIntensity: 0.06, // occasional Poisson jumps
    jumpSigma: 0.004,
  },
]

export const VENUES = [
  {
    id: 'BINANCE',
    assetId: 'BTC',
    basis: 0,
    halfSpread: 4,
    levelStep: 3,
    depthTop: 8,
    k0: 6,
    numLevels: 30,
    jitter: 0.25, // size jitter so the ladder flickers like a real book
    kyleLambda: 0.4,
    phi: 0.2,
  },
]

// Seed resolution: an explicit ?seed=<n> reproduces a path exactly (determinism
// / grading); with no param we randomize each load so refreshes differ. The
// chosen seed is shown in the header so a student can pin a path they liked.
// (Math.random lives only in the UI shell — never in /engine.)
export function readSeed() {
  if (typeof window === 'undefined') return 1
  const raw = new URLSearchParams(window.location.search).get('seed')
  const n = Number(raw)
  if (raw != null && raw !== '' && Number.isFinite(n)) return n
  return Math.floor(Math.random() * 1_000_000_000)
}
