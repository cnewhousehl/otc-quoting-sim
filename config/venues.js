// config/venues.js
//
// Venue roster + asset→venue availability (M7). Profiles are expressed in
// price-relative units (bps, notional) and expanded into concrete per-(venue,
// asset) configs by buildVenues(), so the same exchange profile works across
// assets at very different price levels. All order-book venues are PERPETUAL
// FUTURES; the DEX is a constant-product AMM.
//
//   T1 perp  — tight, deep, tracks the true mid → ~95% of hedging belongs here.
//   T2 perp  — wider, thinner, LAGS the true mid (stale-quote opportunities),
//              slower depth regrowth (less competitive makers).
//   DEX AMM  — exact x·y=k slippage, small pool, fee acts as spread; the only
//              venue for esoteric coins (so those RFQs tolerate wider pricing).

export const EXCHANGES = {
  'binance-perp': {
    tier: 'T1', type: 'perp',
    halfSpreadBps: 0.6, levelStepBps: 0.3, epsBps: 0.1,
    depthTopNotional: 400_000, k0: 6, numLevels: 30, jitter: 0.2,
    kyleLambda: 0.3, phi: 0.2, tau: 4, lagTau: 0,
    updateMult: 1.0, // price-discovery venue, fastest cadence
    toxTau: 8, kSpread: 0.8, kDepth: 0.6, // mid-skew set per-asset in buildVenues
  },
  'bybit-perp': {
    tier: 'T2', type: 'perp',
    halfSpreadBps: 2.0, levelStepBps: 1.0, epsBps: 0.4,
    depthTopNotional: 100_000, k0: 4, numLevels: 24, jitter: 0.35,
    kyleLambda: 0.7, phi: 0.15, tau: 12, lagTau: 3,
    updateMult: 1.5, // price-following venue, lags T1
    toxTau: 10, kSpread: 1.2, kDepth: 0.8,
  },
  'uni-amm': {
    tier: 'DEX', type: 'amm',
    feeBps: 30, poolNotional: 800_000, sampleLevels: 16,
    updateMult: 2.5, // DEX reprices slowly between arbs, small size
  },
}

// Asset universe with which venues list each name. Esoteric coins are DEX-only.
// `sigma` is per-tick (250 ms) log-return stdev. These annualize to realistic
// crypto vols (BTC ~55%, WIF ~165%) — at dt=0.25s, sigma·sqrt(4·86400·365)≈vol.
// `corr` is the loading on the common market factor (alts co-move with majors).
export const ASSET_UNIVERSE = [
  { id: 'BTC', refPrice: 65_000, sigma: 0.000050, corr: 0.90, weight: 0.40, venues: ['binance-perp', 'bybit-perp', 'uni-amm'] },
  { id: 'ETH', refPrice: 3_200, sigma: 0.000060, corr: 0.90, weight: 0.30, venues: ['binance-perp', 'bybit-perp', 'uni-amm'] },
  { id: 'SOL', refPrice: 150, sigma: 0.000090, corr: 0.92, weight: 0.18, venues: ['binance-perp', 'bybit-perp', 'uni-amm'] },
  { id: 'WIF', refPrice: 2.0, sigma: 0.000150, corr: 0.70, weight: 0.12, venues: ['uni-amm'] }, // DEX-only meme
]

const bps = (px, b) => (px * b) / 1e4

// baseUpdateTicks = T1 cadence in ticks (from the session's book-update setting);
// each venue's updateEvery scales by its updateMult.
export function buildVenues(universe = ASSET_UNIVERSE, { baseUpdateTicks = 6 } = {}) {
  const out = []
  const ue = (mult) => Math.max(1, Math.round(baseUpdateTicks * mult))
  for (const a of universe) {
    for (const ex of a.venues) {
      const p = EXCHANGES[ex]
      const id = `${ex}:${a.id}`
      if (p.type === 'amm') {
        out.push({ id, assetId: a.id, type: 'amm', tier: p.tier, feeBps: p.feeBps, poolBase: p.poolNotional / a.refPrice, sampleLevels: p.sampleLevels, updateEvery: ue(p.updateMult) })
      } else {
        const halfSpread = bps(a.refPrice, p.halfSpreadBps)
        const depthTop = p.depthTopNotional / a.refPrice
        out.push({
          id, assetId: a.id, type: 'perp', tier: p.tier,
          basis: 0,
          halfSpread,
          levelStep: bps(a.refPrice, p.levelStepBps),
          epsSigma: bps(a.refPrice, p.epsBps),
          depthTop, k0: p.k0, numLevels: p.numLevels, jitter: p.jitter,
          kyleLambda: p.kyleLambda, phi: p.phi, tau: p.tau, lagTau: p.lagTau, updateEvery: ue(p.updateMult),
          tox: { tau: p.toxTau, refFlow: depthTop * 2, kSpread: p.kSpread, kDepth: p.kDepth, kSkew: halfSpread },
        })
      }
    }
  }
  return out
}

// Venues that list an asset (for routing + RFQ pricing tolerance in M8).
export function venuesForAsset(assetId, universe = ASSET_UNIVERSE) {
  const a = universe.find((x) => x.id === assetId)
  return a ? a.venues.slice() : []
}

export function isDexOnly(assetId, universe = ASSET_UNIVERSE) {
  const v = venuesForAsset(assetId, universe)
  return v.length > 0 && v.every((ex) => EXCHANGES[ex]?.type === 'amm')
}

// Aggregate top-of-book liquidity (notional) listing an asset — used by M8 to
// couple RFQ clip sizes to how liquid the name is. DEX pools count at a fraction
// (you can't move size through a small pool).
export function assetLiquidityNotional(assetId, universe = ASSET_UNIVERSE) {
  const a = universe.find((x) => x.id === assetId)
  if (!a) return 0
  let total = 0
  for (const ex of a.venues) {
    const p = EXCHANGES[ex]
    total += p.type === 'amm' ? p.poolNotional * 0.1 : p.depthTopNotional
  }
  return total
}
