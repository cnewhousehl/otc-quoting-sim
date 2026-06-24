// engine/perpVenue.js
//
// Perpetual-futures order-book venue (M7) — the parametric ladder from M3, now
// with a venue PROFILE: tier (T1/T2), resilience (depth regrowth), toxicity
// reaction (spread widens / hit-side thins / mid skews under your flow), and a
// staleness lag on the reference mid.
//
//   T1 (e.g. a deep major-exchange perp): tight spread, deep, tracks M_t closely
//      → where ~95% of hedging should go.
//   T2 (a smaller perp): wider, thinner, and its reference mid LAGS M_t, so it
//      goes stale — sometimes you can hit a stale-cheap T2 for a better hedge.
//
// Implements the venue handler interface consumed by engine/book.js:
//   mid(), getBookSnapshot(), executeMarketable({side,size}), tick(n).

import { STREAMS } from './rng.js'
import { createResilience } from './resilience.js'
import { createToxicity } from './toxicity.js'

const IDX = Object.freeze({ eps: 0, jitterAsk: 2000, jitterBid: 4000 })

function defaults(cfg) {
  return {
    id: cfg.id,
    assetId: cfg.assetId,
    tier: cfg.tier ?? 'T1',
    basis: cfg.basis ?? 0,
    epsSigma: cfg.epsSigma ?? 0,
    halfSpread: cfg.halfSpread,
    levelStep: cfg.levelStep,
    depthTop: cfg.depthTop,
    k0: cfg.k0 ?? 4,
    numLevels: cfg.numLevels ?? 25,
    jitter: cfg.jitter ?? 0,
    kyleLambda: cfg.kyleLambda ?? 0,
    phi: cfg.phi ?? 0,
    tau: cfg.tau ?? 0, // resilience time-constant (0 → instant regrow)
    lagTau: cfg.lagTau ?? 0, // staleness lag (0 → tracks M_t exactly); T2 large
    updateEvery: Math.max(1, cfg.updateEvery ?? 1), // discrete repaint cadence (T1=1, T2=2…)
    tox: cfg.tox ?? null, // { tau, refFlow, kSpread, kDepth, kSkew }
  }
}

export function createPerpVenue({ rng, price, dt, cfg: rawCfg }) {
  const cfg = defaults(rawCfg)
  const resilience = createResilience({ tau: cfg.tau, dt })
  const tox = createToxicity({ dt, ...(cfg.tox ?? {}) })

  // steady total depth on one side (for depletion fractions)
  let steadyDepth = 0
  for (let k = 0; k < cfg.numLevels; k++) steadyDepth += cfg.depthTop * Math.exp(-k / cfg.k0)

  let skewImpact = 0 // accumulated permanent (Kyle-λ) impact, price units
  let lagged = price.mid(cfg.assetId)
  let heldAnchor = price.mid(cfg.assetId) // displayed reference, refreshed discretely
  let heldEps = 0
  let heldTick = 0 // tick of the last refresh — size jitter holds between refreshes
  let lastTick = 0
  let stress = 0 // news-driven stress: widens spread, thins depth
  const STRESS_SPREAD = 2.5
  const STRESS_DEPTH = 0.8
  const setStress = (s) => {
    stress = s
  }

  // Displayed reference mid. The anchor/ε only refresh every `updateEvery` ticks
  // (T1 fast, T2/T3 slower) so the book updates on the order of seconds, not
  // 4×/sec. Impact/toxicity skews still respond to trades immediately.
  function refMid() {
    return heldAnchor + cfg.basis + heldEps + skewImpact + tox.skew(cfg.id)
  }

  const effHalfSpread = () => cfg.halfSpread * tox.spreadMult(cfg.id) * (1 + STRESS_SPREAD * stress)

  function levelSize(n, k, side) {
    const base = cfg.depthTop * Math.exp(-k / cfg.k0)
    const idx = (side === 'ask' ? IDX.jitterAsk : IDX.jitterBid) + k
    const jit = cfg.jitter > 0 ? 1 + cfg.jitter * (2 * rng.uniform(STREAMS.book, heldTick, cfg.id, idx) - 1) : 1
    const mult = (resilience.get(`${cfg.id}:${side}`) * tox.depthMult(cfg.id, side)) / (1 + STRESS_DEPTH * stress)
    return base * jit * mult
  }

  function buildLadder(n) {
    const m = refMid()
    const hs = effHalfSpread()
    const bids = []
    const asks = []
    for (let k = 0; k < cfg.numLevels; k++) {
      asks.push({ price: m + hs + k * cfg.levelStep, size: levelSize(n, k, 'ask') })
      bids.push({ price: m - hs - k * cfg.levelStep, size: levelSize(n, k, 'bid') })
    }
    return { mid: m, spread: 2 * hs, bids, asks }
  }

  function tick(n) {
    lastTick = n
    if (cfg.lagTau > 0) {
      const a = 1 - Math.exp(-dt / cfg.lagTau)
      lagged += (price.mid(cfg.assetId) - lagged) * a
    }
    // Discrete repaint: refresh the displayed anchor/ε only on the cadence.
    if (n % cfg.updateEvery === 0) {
      heldAnchor = cfg.lagTau > 0 ? lagged : price.mid(cfg.assetId)
      heldEps = cfg.epsSigma > 0 ? cfg.epsSigma * rng.normal(STREAMS.book, n, cfg.id, IDX.eps) : 0
      heldTick = n // size jitter only re-rolls on the cadence too
    }
    resilience.regrow()
    tox.decayAll()
    skewImpact *= 0.997 // accumulated impact heals slowly (temporary component)
  }

  const getBookSnapshot = () => buildLadder(lastTick)
  const mid = () => refMid()

  function executeMarketable({ side, size }) {
    const ladder = buildLadder(lastTick)
    const midPx = ladder.mid
    const levels = side === 'buy' ? ladder.asks : ladder.bids
    let remaining = size
    let cost = 0
    let filled = 0
    const consumed = []
    for (const lvl of levels) {
      if (remaining <= 0) break
      const take = Math.min(remaining, lvl.size)
      cost += take * lvl.price
      filled += take
      remaining -= take
      consumed.push({ price: lvl.price, size: take })
    }
    const vwap = filled > 0 ? cost / filled : midPx
    const slippagePerUnit = side === 'buy' ? vwap - midPx : midPx - vwap

    // Permanent Kyle-λ impact, signed; φ fraction feeds the true mid.
    const signed = side === 'buy' ? filled : -filled
    const impactReturn = cfg.kyleLambda * (signed / cfg.depthTop)
    skewImpact += midPx * impactReturn
    if (cfg.phi !== 0 && impactReturn !== 0) price.nudge(cfg.assetId, cfg.phi * impactReturn)

    // Deplete the consumed side (resilience) and register the lean (toxicity).
    const consumedSide = side === 'buy' ? 'ask' : 'bid'
    resilience.consume(`${cfg.id}:${consumedSide}`, filled / steadyDepth)
    tox.observe(cfg.id, signed)

    return {
      side,
      requestedSize: size,
      filledSize: filled,
      partial: remaining > 1e-12,
      vwap,
      mid: midPx,
      slippagePerUnit,
      slippage: slippagePerUnit * filled,
      impactReturn,
      consumed,
    }
  }

  // Non-mutating estimate of the cost (bps vs mid) to take `size` on a side —
  // for showing the student how expensive a clip is to hedge before they quote.
  function estimateCost(side, size) {
    const ladder = buildLadder(lastTick)
    const levels = side === 'buy' ? ladder.asks : ladder.bids
    let remaining = size
    let cost = 0
    let filled = 0
    for (const lvl of levels) {
      if (remaining <= 0) break
      const take = Math.min(remaining, lvl.size)
      cost += take * lvl.price
      filled += take
      remaining -= take
    }
    const vwap = filled > 0 ? cost / filled : ladder.mid
    return { vwap, filledSize: filled, partial: remaining > 1e-9, slipBps: (Math.abs(vwap - ladder.mid) / ladder.mid) * 1e4, mid: ladder.mid }
  }

  // Cross-venue contagion (M9.6): aggressive flow on a sibling venue makes THIS
  // venue's makers wary too — feed the lean into toxicity without consuming
  // depth. So hitting T1 widens/thins T2 (and vice versa). DEX venues are immune.
  function observeExternalFlow(signed) {
    tox.observe(cfg.id, signed)
  }

  return { id: cfg.id, assetId: cfg.assetId, type: 'perp', tier: cfg.tier, mid, getBookSnapshot, executeMarketable, estimateCost, tick, observeExternalFlow, setStress }
}
