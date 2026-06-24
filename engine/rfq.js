// engine/rfq.js
//
// RFQ arrivals (PLAN.md §1.1 rfq.js, M8). Poisson arrivals at the difficulty's
// rate; the asset is drawn from the weighted universe (majors frequent, esoteric
// rare); the client is drawn so the toxic/sharp SHARE of flow ≈ p_tox (so Hard
// brings more informed flow); clip size couples to the asset's liquidity
// (size = a fraction of top-of-book depth × LogNormal) so liquid names get big
// clips and thin names get small ones. The pending cap suppresses new arrivals.
//
// Toxicity is decided HERE at creation (Q3 sample-at-creation): a toxic RFQ comes
// from a sharp client and will carry post-fill adverse drift once it fills.

import { STREAMS } from './rng.js'

export function createRfqGenerator({ rng, dt, difficulty, universe, roster, liquidityNotional, sizeFrac = 0.08, sigmaLN = 0.8 }) {
  let seq = 0
  const sharp = roster.filter((c) => c.archetype === 'sharp')
  const mids = roster.filter((c) => c.archetype === 'mid')
  const softs = roster.filter((c) => c.archetype === 'soft')
  const totalWeight = universe.reduce((s, a) => s + a.weight, 0)

  function weightedAsset(u) {
    let x = u * totalWeight
    for (const a of universe) {
      if (x < a.weight) return a
      x -= a.weight
    }
    return universe[universe.length - 1]
  }

  const pickFrom = (arr, u) => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))]

  // Client + toxicity: sharp (toxic) with prob p_tox; otherwise mostly soft, with
  // some ambiguous 'mid' that is toxic ~half the time (makes Hard's masked names
  // genuinely hard to read).
  function pickClient(n, id) {
    const uGroup = rng.uniform(STREAMS.rfqSpec, n, id, 1)
    const uPick = rng.uniform(STREAMS.rfqSpec, n, id, 2)
    if (sharp.length && uGroup < difficulty.pTox) {
      return { entry: pickFrom(sharp, uPick), isToxic: true }
    }
    const uSplit = rng.uniform(STREAMS.rfqSpec, n, id, 3)
    if (mids.length && uSplit < 0.3) {
      const isToxic = rng.uniform(STREAMS.rfqSpec, n, id, 4) < 0.5
      return { entry: pickFrom(mids, uPick), isToxic }
    }
    return { entry: pickFrom(softs.length ? softs : roster, uPick), isToxic: false }
  }

  function sizeFor(asset, n, id) {
    const medianNotional = liquidityNotional(asset.id) * sizeFrac
    const z = rng.normal(STREAMS.rfqSpec, n, id, 5)
    const notional = medianNotional * Math.exp(sigmaLN * z) // LogNormal multiplier
    return Math.max(1e-9, notional / asset.refPrice) // base units
  }

  // One tick. Returns a new RFQ, or null (no arrival / cap hit). `pendingCount`
  // is the number of RFQs currently awaiting a quote.
  function step(n, pendingCount) {
    if (pendingCount >= difficulty.maxPendingRFQs) return null
    const pArrival = difficulty.arrivalRate * dt
    if (rng.uniform(STREAMS.rfqArrival, n, 'arrival', 0) >= pArrival) return null

    const id = `rfq${++seq}`
    const asset = weightedAsset(rng.uniform(STREAMS.rfqArrival, n, id, 1))
    const { entry, isToxic } = pickClient(n, id)
    const size = sizeFor(asset, n, id)
    return {
      id,
      tick: n,
      assetId: asset.id,
      refPrice: asset.refPrice,
      clientId: entry.id,
      handle: entry.handle,
      archetype: entry.archetype,
      size,
      notional: size * asset.refPrice,
      isToxic,
    }
  }

  return { step }
}
