// config/difficulty.js
//
// The Easy/Medium/Hard parameter bundle (PLAN.md Q6). A single difficulty dial
// rewrites the whole engine's behavior. Values marked "(Q6)" are the spec's
// concrete coefficients; auxiliary constants needed by the math but not pinned
// in Q6 are chosen here and tuned jointly with the Q7 calibration suite (M10).
//
// `hazardScale` is the global D_diff multiplier on every fill hazard — it brings
// the per-tick cumulative hazard into a sane range given dt/TTL (M10 owns its
// final value). Session-level knobs (arrival, maxPendingRFQs, transparency) are
// consumed by M8/M9.

// Auxiliary (non-Q6) constants shared across levels unless overridden.
const AUX = {
  softS1: 2.2, // soft logistic amplitude (calibrated for the reservation-spread model)
  softB: 0.6, // soft logistic slope (reservation units)
  sharpLambda: 0.4, // sharp contact rate (spike comes from g_sharp, not λ)
  rho: 0.85, // toxic-drift exponential decay per tick
  xRef: 5, // size reference for L(X)
  tauReact: 2.0, // decision-latency time constant (s)
}

function level({ pTox, softLambda, s0, omega, q0, aPick, bSharp, theta, pickoffScale, deltaTox, N, eta, hazardScale, arrivalRate, maxPendingRFQs, transparency, reservationBps, bookUpdateSec, fillShapes, biasGainBps, favorDecay }) {
  return {
    // Hedge-cost-anchored fill model (per archetype): reservation = hedgeCost +
    // bufferBps; slopeBps sets cutoff sharpness; floor is the residual fill rate
    // for very wide quotes; relStrength = how much relationship/favor widens it.
    fillShapes,
    biasGainBps, // per-σ-of-bias shift of the per-side reservation (bps)
    favorDecay, // per-tick pull of relationship favor back to neutral
    // Soft-fill width scale (bps of mid): a fair clip fills well out to ~this
    // width, and (with size/bias) you can still win flow quoting ~1%.
    reservationBps,
    bookUpdateSec, // default book repaint cadence (slower = calmer/easier)
    pTox, // (Q6) sharp/toxic share of flow
    soft: { lambda: softLambda, s0, s1: AUX.softS1, omega, b: AUX.softB }, // (Q6) λ_soft, s0, ω_soft
    // (Q6) q0, A_pick, θ_sharp, b_sharp; pickoffScale is the §1.3 "stale-pickoff
    // aggression" dial (damped on easy) applied to the pickoff gain.
    sharp: { lambda: AUX.sharpLambda, q0, aPick, theta, b: bSharp, pickoffScale },
    toxic: { deltaTox, N, rho: AUX.rho }, // (Q6) δ_tox, N
    eta, // (Q6) size sensitivity η
    xRef: AUX.xRef,
    tauReact: AUX.tauReact,
    hazardScale, // global D_diff (M10-tunable)
    arrivalRate, // (Q6) RFQ/s — consumed by M8
    maxPendingRFQs, // (Q6) — consumed by M8
    transparency, // (Q6) name→toxicity reveal — consumed by M9 UI
  }
}

export const DIFFICULTY = {
  easy: level({
    pTox: 0.15, softLambda: 0.4, s0: 0.06, omega: 0.0,
    q0: 0.02, aPick: 0.6, bSharp: 0.6, theta: 0.3, pickoffScale: 0.6,
    deltaTox: 0.8, N: 16, eta: 0.3,
    hazardScale: 0.075, arrivalRate: 0.5, maxPendingRFQs: 3, transparency: 'full',
    reservationBps: 90, bookUpdateSec: 5, biasGainBps: 45, favorDecay: 0.004,
    fillShapes: {
      sharp: { bufferBps: 14, slopeBps: 16, floor: 0.04, lambda: 0.5, relStrength: 1.2 },
      mid: { bufferBps: 40, slopeBps: 46, floor: 0.08, lambda: 0.42, relStrength: 1.6 },
      soft: { bufferBps: 85, slopeBps: 95, floor: 0.16, lambda: 0.4, relStrength: 0.3 },
    },
  }),
  medium: level({
    pTox: 0.35, softLambda: 0.32, s0: 0.05, omega: 0.0,
    q0: 0.02, aPick: 1.4, bSharp: 0.45, theta: 0.1, pickoffScale: 1.0,
    deltaTox: 1.6, N: 24, eta: 0.2,
    hazardScale: 0.075, arrivalRate: 0.8, maxPendingRFQs: 5, transparency: 'archetype',
    reservationBps: 60, bookUpdateSec: 2.5, biasGainBps: 30, favorDecay: 0.004,
    fillShapes: {
      sharp: { bufferBps: 8, slopeBps: 10, floor: 0.03, lambda: 0.5, relStrength: 1.2 },
      mid: { bufferBps: 24, slopeBps: 30, floor: 0.06, lambda: 0.4, relStrength: 1.7 },
      soft: { bufferBps: 58, slopeBps: 68, floor: 0.12, lambda: 0.38, relStrength: 0.3 },
    },
  }),
  hard: level({
    pTox: 0.6, softLambda: 0.28, s0: 0.04, omega: 0.0,
    q0: 0.03, aPick: 2.6, bSharp: 0.35, theta: 0.0, pickoffScale: 1.0,
    deltaTox: 2.6, N: 32, eta: 0.12,
    hazardScale: 0.075, arrivalRate: 1.2, maxPendingRFQs: 8, transparency: 'hidden',
    reservationBps: 38, bookUpdateSec: 1, biasGainBps: 20, favorDecay: 0.004,
    fillShapes: {
      sharp: { bufferBps: 4, slopeBps: 6, floor: 0.02, lambda: 0.55, relStrength: 1.2 },
      mid: { bufferBps: 15, slopeBps: 19, floor: 0.05, lambda: 0.36, relStrength: 1.7 },
      soft: { bufferBps: 38, slopeBps: 46, floor: 0.09, lambda: 0.34, relStrength: 0.3 },
    },
  }),
}

export const DIFFICULTY_LEVELS = Object.freeze(['easy', 'medium', 'hard'])

export function getDifficulty(name) {
  const d = DIFFICULTY[name]
  if (!d) throw new Error(`unknown difficulty: ${name}`)
  return d
}
