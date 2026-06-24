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

export function createRfqGenerator({ rng, dt, difficulty, universe, roster, liquidityNotional, favorFn = null, pToxFor = null, sizeFrac = 0.13, sigmaLN = 1.15, blockProb = 0.06, blockMult = 4 }) {
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

  // Favor scales how often a client comes back: a well-treated client appears
  // more (weight 0.3..1.3 around the 0.5 neutral favor). Courting a toxic name's
  // favor is self-punishing — it brings back more −EV flow.
  function pickFrom(arr, u) {
    if (!favorFn || arr.length <= 1) return arr[Math.min(arr.length - 1, Math.floor(u * arr.length))]
    const w = arr.map((c) => 0.3 + (favorFn(c.id) ?? 0.5))
    const total = w.reduce((a, b) => a + b, 0)
    let x = u * total
    for (let i = 0; i < arr.length; i++) {
      if (x < w[i]) return arr[i]
      x -= w[i]
    }
    return arr[arr.length - 1]
  }

  // Client + toxicity: sharp (toxic) with prob p_tox (asset-specific on Hard via
  // clustered-toxic bumps); otherwise mostly soft, with some ambiguous 'mid'.
  function pickClient(n, id, assetId) {
    const pTox = pToxFor ? pToxFor(assetId) : difficulty.pTox
    const uGroup = rng.uniform(STREAMS.rfqSpec, n, id, 1)
    const uPick = rng.uniform(STREAMS.rfqSpec, n, id, 2)
    if (sharp.length && uGroup < pTox) {
      return { entry: pickFrom(sharp, uPick), isToxic: true }
    }
    const uSplit = rng.uniform(STREAMS.rfqSpec, n, id, 3)
    if (mids.length && uSplit < 0.3) {
      const isToxic = rng.uniform(STREAMS.rfqSpec, n, id, 4) < 0.5
      return { entry: pickFrom(mids, uPick), isToxic }
    }
    return { entry: pickFrom(softs.length ? softs : roster, uPick), isToxic: false }
  }

  // Clip size couples to the asset's CURRENT visible depth (which shrinks when the
  // book widens/thins under flow or news), with high variance so hedge costs span
  // ~1bp to ~100bps. Occasional event-size BLOCKS (more likely around news) are
  // offload opportunities. stress ∈ [0,1] is the live news stress.
  function sizeFor(asset, n, id, stress = 0) {
    const liq = liquidityNotional(asset.id)
    const base = liq * sizeFrac
    const z = rng.normal(STREAMS.rfqSpec, n, id, 5)
    let mult = Math.min(8, Math.exp(sigmaLN * z)) // LogNormal, capped — no absurd tails
    if (rng.uniform(STREAMS.rfqSpec, n, id, 7) < blockProb + 0.18 * stress) {
      mult *= blockMult * (1 + 0.5 * stress) // event-size block (offload opportunity)
    }
    // Cap at "barely hedgeable" (~1.5× visible depth), never "impossible".
    const notional = Math.min(liq * 1.5, Math.max(asset.refPrice, base * mult))
    return notional / asset.refPrice // base units
  }

  // One tick. Returns a new RFQ, or null (no arrival / cap hit). `pendingCount`
  // is the number of RFQs awaiting a quote; `stress` is the live news stress.
  function step(n, pendingCount, stress = 0) {
    if (pendingCount >= difficulty.maxPendingRFQs) return null
    const pArrival = difficulty.arrivalRate * dt
    if (rng.uniform(STREAMS.rfqArrival, n, 'arrival', 0) >= pArrival) return null

    const id = `rfq${++seq}`
    const asset = weightedAsset(rng.uniform(STREAMS.rfqArrival, n, id, 1))
    const { entry, isToxic } = pickClient(n, id, asset.id)
    const size = sizeFor(asset, n, id, stress)
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
