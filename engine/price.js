// engine/price.js
//
// Hidden true-mid M_t per asset (PLAN.md §1.1 price.js, Q1/Q3).
//
// GBM with regime-switchable drift {flat, up, down, mean-revert} plus optional
// Poisson jumps. The per-tick price stdev σ_M (price units) is exposed because
// it is the unit every hazard/edge calculation is normalized by (Q1: edges are
// dimensionless in edge/σ_M).
//
// The true mid is NEVER surfaced to the UI — students infer fair from the books.
// Only the engine (and the grader, via runFromSeed) may read it.
//
// Attribution (Q3): each tick's return splits into r_GBM (diffusion + jumps —
// the "market" move that drives inventory MtM) and r_tox (externally injected
// adverse drift from a toxic fill — drives adverse-selection P&L). step() takes
// the per-asset injected r_tox for the tick and keeps the two components apart.

import { STREAMS } from './rng.js'

export const REGIMES = Object.freeze({
  flat: 'flat',
  up: 'up',
  down: 'down',
  meanRevert: 'mean-revert',
})

const REGIME_LIST = [REGIMES.flat, REGIMES.up, REGIMES.down, REGIMES.meanRevert]

// localIdx slots within a (stream, n, assetId) cell, kept distinct so one draw
// never collides with another on the same coordinate.
const IDX = Object.freeze({
  diffusion: 0, // STREAMS.price
  switchRoll: 100, // STREAMS.price
  switchPick: 101, // STREAMS.price
  jumpRoll: 0, // STREAMS.jump
  jumpSize: 1, // STREAMS.jump
})

function defaultsForAsset(a) {
  return {
    id: a.id,
    m0: a.m0,
    sigma: a.sigma, // per-tick log-return stdev (σ_M = M · sigma in price units)
    regime: a.regime ?? REGIMES.flat,
    driftPerTick: a.driftPerTick ?? 0, // base drift (return space) added in all regimes
    driftMag: a.driftMag ?? 0, // ± magnitude applied by up/down regimes
    meanRevertKappa: a.meanRevertKappa ?? 0.01, // pull strength toward anchor
    anchor: a.anchor ?? a.m0, // mean-revert target
    jumpIntensity: a.jumpIntensity ?? 0, // expected jumps per SECOND (Poisson λ)
    jumpSigma: a.jumpSigma ?? 0, // jump size stdev (return space)
    regimeSwitchProb: a.regimeSwitchProb ?? 0, // per-tick Markov switch prob (0 = fixed)
  }
}

// Drift (return space) for the current regime given the current mid.
function regimeDrift(cfg, M) {
  switch (cfg.regime) {
    case REGIMES.up:
      return cfg.driftPerTick + cfg.driftMag
    case REGIMES.down:
      return cfg.driftPerTick - cfg.driftMag
    case REGIMES.meanRevert:
      return cfg.driftPerTick - cfg.meanRevertKappa * Math.log(M / cfg.anchor)
    case REGIMES.flat:
    default:
      return cfg.driftPerTick
  }
}

// createPriceProcess({ rng, dt, assets }) -> price process.
//   assets: [{ id, m0, sigma, regime?, driftPerTick?, driftMag?, meanRevertKappa?,
//              anchor?, jumpIntensity?, jumpSigma?, regimeSwitchProb? }]
export function createPriceProcess({ rng, dt, assets }) {
  const cfgs = new Map()
  const state = new Map() // id -> { M, rGBM, rTox, jumped, regime }
  for (const a of assets) {
    const cfg = defaultsForAsset(a)
    cfgs.set(cfg.id, cfg)
    state.set(cfg.id, { M: cfg.m0, rGBM: 0, rTox: 0, jumped: false, regime: cfg.regime })
  }

  function maybeSwitchRegime(cfg, n) {
    if (cfg.regimeSwitchProb <= 0) return
    if (rng.uniform(STREAMS.price, n, cfg.id, IDX.switchRoll) < cfg.regimeSwitchProb) {
      const u = rng.uniform(STREAMS.price, n, cfg.id, IDX.switchPick)
      cfg.regime = REGIME_LIST[Math.min(REGIME_LIST.length - 1, Math.floor(u * REGIME_LIST.length))]
    }
  }

  // Advance every asset one tick. `injected` maps assetId -> additive r_tox
  // (return space) for this tick; missing entries default to 0.
  function step(n, injected = null) {
    for (const [id, cfg] of cfgs) {
      const s = state.get(id)
      maybeSwitchRegime(cfg, n)
      s.regime = cfg.regime

      const mu = regimeDrift(cfg, s.M)
      const z = rng.normal(STREAMS.price, n, id, IDX.diffusion)
      // Itô correction so E[M] tracks the intended drift even at larger sigma.
      const diffusion = mu - 0.5 * cfg.sigma * cfg.sigma + cfg.sigma * z

      let jump = 0
      s.jumped = false
      if (cfg.jumpIntensity > 0) {
        const pJump = cfg.jumpIntensity * dt
        if (rng.uniform(STREAMS.jump, n, id, IDX.jumpRoll) < pJump) {
          jump = cfg.jumpSigma * rng.normal(STREAMS.jump, n, id, IDX.jumpSize)
          s.jumped = true
        }
      }

      const rGBM = diffusion + jump
      const rTox = injected && injected[id] ? injected[id] : 0
      s.rGBM = rGBM
      s.rTox = rTox
      s.M = s.M * Math.exp(rGBM + rTox)
    }
    return snapshot()
  }

  // Hidden true mid — engine-internal only.
  function mid(id) {
    return state.get(id).M
  }

  // Permanent-impact feedback (Q: "your flow is information"). The book applies a
  // fraction φ of its Kyle-λ impact to the true mid via this hook. Applied
  // immediately (between diffusion steps), in return space.
  function nudge(id, returnDelta) {
    const s = state.get(id)
    s.M = s.M * Math.exp(returnDelta)
  }

  // Per-tick price stdev in PRICE units (the σ_M hazard math normalizes by).
  function sigmaM(id) {
    return state.get(id).M * cfgs.get(id).sigma
  }

  // Last tick's return components for attribution (Q3).
  function components(id) {
    const s = state.get(id)
    return { rGBM: s.rGBM, rTox: s.rTox, jumped: s.jumped }
  }

  function assetIds() {
    return [...cfgs.keys()]
  }

  function snapshot() {
    const out = {}
    for (const [id, s] of state) {
      out[id] = { mid: s.M, sigmaM: s.M * cfgs.get(id).sigma, regime: s.regime }
    }
    return out
  }

  return { step, mid, nudge, sigmaM, components, assetIds, snapshot }
}
