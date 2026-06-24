// config/session.js
//
// Default session settings (PLAN.md §1.5, M9). One object tunes everything; the
// engine reads it, no code edits to retune. Scenarios shift the price regime/vol.

import { ASSET_UNIVERSE, buildVenues } from './venues.js'

export const SCENARIOS = {
  calm: { regime: 'flat', volMult: 1.0, jumpMult: 1.0, driftMag: 0 },
  trending: { regime: 'up', volMult: 1.1, jumpMult: 1.0, driftMag: 0.0006 },
  'vol-spike': { regime: 'flat', volMult: 2.2, jumpMult: 3.0, driftMag: 0 },
  'toxic-day': { regime: 'mean-revert', volMult: 1.4, jumpMult: 2.0, driftMag: 0 },
}

export const DEFAULT_SESSION = {
  dt: 0.25, // 250 ms tick
  ttlTicks: 180, // quote TTL = 45 s once live
  pendingTtlTicks: 240, // you get ~60 s to respond to an RFQ before it expires
  sessionMinutes: 20,
  scenario: 'calm',
  hedgeFeeBps: 1.0, // taker fee on hedges (student is maker on client fills → no fee)
  softInventoryUsd: 250_000, // discretionary warehouse warning threshold
  jumpIntensityBase: 0.012, // per-asset Poisson λ baseline (× scenario jumpMult) — rare on calm
  jumpSigmaBase: 0.004,
  newsIntervalMin: 3, // news catalyst cadence (customizable 1–10)
}

// Build the concrete asset + venue arrays for a session from the universe and a
// scenario. Assets carry their hidden-mid params; venues come from buildVenues().
export function buildSessionWorld(cfg) {
  const sc = SCENARIOS[cfg.scenario] ?? SCENARIOS.calm
  const assets = ASSET_UNIVERSE.map((a) => ({
    id: a.id,
    m0: a.refPrice,
    sigma: a.sigma * sc.volMult,
    regime: sc.regime,
    driftMag: sc.driftMag,
    anchor: a.refPrice,
    corr: a.corr ?? 0,
    jumpIntensity: cfg.jumpIntensityBase * sc.jumpMult,
    jumpSigma: cfg.jumpSigmaBase * sc.volMult,
  }))
  const baseUpdateTicks = Math.max(1, Math.round((cfg.bookUpdateSec ?? 2.5) / cfg.dt))
  return { assets, venues: buildVenues(ASSET_UNIVERSE, { baseUpdateTicks }), universe: ASSET_UNIVERSE }
}
