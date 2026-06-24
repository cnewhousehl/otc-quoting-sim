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
    levelGrowth: cfg.levelGrowth ?? 0,
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

  // Per-level resting size = a depletable top-book (decays with depth, thins under
  // flow/news) PLUS a deep non-depletable tail so a marketable sweep ALWAYS fills
  // (just at worse prices) — resting liquidity can't be pulled.
  function levelSize(k, side) {
    const idx = (side === 'ask' ? IDX.jitterAsk : IDX.jitterBid) + k
    const jit = cfg.jitter > 0 ? 1 + cfg.jitter * (2 * rng.uniform(STREAMS.book, heldTick, cfg.id, idx) - 1) : 1
    const mult = (resilience.get(`${cfg.id}:${side}`) * tox.depthMult(cfg.id, side)) / (1 + STRESS_DEPTH * stress)
    const top = cfg.depthTop * Math.exp(-k / cfg.k0) * jit * mult // depletable
    const tail = cfg.depthTop * 0.2 * jit // deep resting liquidity, always present
    return top + tail
  }

  // Level price offset grows with depth: tight near top, steps WIDEN deeper, so
  // the visible book spans a realistic price range and big clips clear deep/wide.
  const levelOffset = (k) => cfg.levelStep * k * (1 + (cfg.levelGrowth ?? 0) * k)
  const levelPrice = (m, hs, k, side) => (side === 'ask' ? m + hs + levelOffset(k) : m - hs - levelOffset(k))

  function buildLadder() {
    const m = refMid()
    const hs = effHalfSpread()
    const bids = []
    const asks = []
    for (let k = 0; k < cfg.numLevels; k++) {
      asks.push({ price: levelPrice(m, hs, k, 'ask'), size: levelSize(k, 'ask') })
      bids.push({ price: levelPrice(m, hs, k, 'bid'), size: levelSize(k, 'bid') })
    }
    return { mid: m, spread: 2 * hs, bids, asks }
  }

  // Sweep the book for a marketable order: walk levels (extending past the
  // displayed depth at progressively worse prices) until the FULL size fills.
  // Resting liquidity can't be pulled — you always get filled, just deeper.
  function walk(side, size) {
    const m = refMid()
    const hs = effHalfSpread()
    const ladderSide = side === 'buy' ? 'ask' : 'bid'
    let remaining = size
    let cost = 0
    let filled = 0
    let lastK = 0
    for (let k = 0; k < 50000 && remaining > 1e-9; k++) {
      const sz = levelSize(k, ladderSide)
      if (sz <= 0) continue
      const take = Math.min(remaining, sz)
      cost += take * levelPrice(m, hs, k, ladderSide)
      filled += take
      remaining -= take
      lastK = k
    }
    // marginal (clearing) bps you swept to — used for the post-trade impact
    const marginalBps = (levelOffset(lastK) / m) * 1e4
    return { m, filled, vwap: filled > 0 ? cost / filled : m, partial: remaining > 1e-6, marginalBps }
  }

  function tick(n) {
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

  const getBookSnapshot = () => buildLadder()
  const mid = () => refMid()

  function executeMarketable({ side, size }) {
    const { m: midPx, filled, vwap, partial, marginalBps } = walk(side, size)
    const slippagePerUnit = side === 'buy' ? vwap - midPx : midPx - vwap

    // Post-sweep impact is proportional to HOW DEEP you swept (not size/depthTop):
    // the venue mid shifts a fraction of the clearing level (temporary, heals via
    // skewImpact decay), and φ of that informs the true mid (information leakage).
    const signed = side === 'buy' ? 1 : -1
    const impactReturn = signed * 0.32 * (marginalBps / 1e4)
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
      partial,
      vwap,
      mid: midPx,
      slippagePerUnit,
      slippage: slippagePerUnit * filled,
      impactReturn,
    }
  }

  // Non-mutating estimate of the cost (bps vs mid) to sweep `size` on a side.
  function estimateCost(side, size) {
    const { m, filled, vwap, partial } = walk(side, size)
    return { vwap, filledSize: filled, partial, slipBps: (Math.abs(vwap - m) / m) * 1e4, mid: m }
  }

  // Cross-venue contagion (M9.6): aggressive flow on a sibling venue makes THIS
  // venue's makers wary too — feed the lean into toxicity without consuming
  // depth. So hitting T1 widens/thins T2 (and vice versa). DEX venues are immune.
  function observeExternalFlow(signed) {
    tox.observe(cfg.id, signed)
  }

  return { id: cfg.id, assetId: cfg.assetId, type: 'perp', tier: cfg.tier, mid, getBookSnapshot, executeMarketable, estimateCost, tick, observeExternalFlow, setStress }
}
