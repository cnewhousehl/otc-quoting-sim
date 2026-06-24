// engine/book.js
//
// Per-venue L2 order book (PLAN.md §1.1 book.js, M3).
//
// STABLE INTERFACE — the whole point is that the Phase-1b agent-MM matching LOB
// (M11) can drop in behind exactly these methods:
//   getBookSnapshot(venueId)          -> { mid, spread, bids[], asks[] }
//   executeMarketable(order)          -> { vwap, filledSize, slippage, ... }
//   mid(venueId)                      -> reference mid m_v
//   tick(n)                           -> refresh per-tick noise / displayed ladder
//
// Phase-1a implementation: a parametric ladder around m_v = M_t + basis_v + ε_v,
// depth D_v·exp(−k/k0) by level, seeded size jitter. Marketable orders walk the
// book for a VWAP; Kyle-λ permanent impact λ_v·signed/D_v shifts the venue and
// feeds a fraction φ back into the hidden true mid M_t (your flow is information).

import { STREAMS } from './rng.js'

const IDX = Object.freeze({
  eps: 0, // ε_v reference noise, per (book, n, venueId)
  jitterBase: 1000, // size jitter base; level k uses jitterBase + k
})

function defaultsForVenue(v) {
  return {
    id: v.id,
    assetId: v.assetId,
    basis: v.basis ?? 0, // structural offset m_v − M_t
    epsSigma: v.epsSigma ?? 0, // per-tick reference noise stdev (price units)
    halfSpread: v.halfSpread, // s_v (price units), top-of-book half-spread
    levelStep: v.levelStep, // price increment between ladder levels
    depthTop: v.depthTop, // D_v, size at the top level
    k0: v.k0 ?? 4, // depth decay scale
    numLevels: v.numLevels ?? 25,
    jitter: v.jitter ?? 0, // fractional size jitter amplitude
    kyleLambda: v.kyleLambda ?? 0, // λ_v permanent-impact coefficient (return space)
    phi: v.phi ?? 0, // fraction of impact fed back into M_t
  }
}

// createBook({ rng, price, venues }) -> book.
//   price: the price process (engine/price.js) — supplies hidden M_t and the
//          nudge() feedback hook. venues: array of venue configs (see defaults).
export function createBook({ rng, price, venues }) {
  const cfgs = new Map()
  const state = new Map() // venueId -> { eps, skew }
  for (const v of venues) {
    const cfg = defaultsForVenue(v)
    cfgs.set(cfg.id, cfg)
    state.set(cfg.id, { eps: 0, skew: 0 }) // skew = accumulated permanent impact (price units)
  }

  // Reference mid for a venue: hidden true mid + structural basis + per-tick
  // noise + accumulated permanent-impact skew.
  function mid(venueId) {
    const cfg = cfgs.get(venueId)
    const s = state.get(venueId)
    return price.mid(cfg.assetId) + cfg.basis + s.eps + s.skew
  }

  function levelSize(cfg, n, k) {
    const base = cfg.depthTop * Math.exp(-k / cfg.k0)
    if (cfg.jitter <= 0) return base
    // Symmetric jitter in [1−j, 1+j]; deterministic per (venue, n, level).
    const u = rng.uniform(STREAMS.book, n, cfg.id, IDX.jitterBase + k)
    return base * (1 + cfg.jitter * (2 * u - 1))
  }

  // Build the live ladder around the current mid for a venue at tick n.
  function buildLadder(venueId, n) {
    const cfg = cfgs.get(venueId)
    const m = mid(venueId)
    const bids = []
    const asks = []
    for (let k = 0; k < cfg.numLevels; k++) {
      const size = levelSize(cfg, n, k)
      asks.push({ price: m + cfg.halfSpread + k * cfg.levelStep, size })
      bids.push({ price: m - cfg.halfSpread - k * cfg.levelStep, size })
    }
    return { mid: m, spread: 2 * cfg.halfSpread, bids, asks }
  }

  let lastTick = 0

  // Refresh per-tick reference noise. Resilience/depletion arrives in M7; here
  // the ladder is rebuilt full-depth each tick from the current mid.
  function tick(n) {
    lastTick = n
    for (const [id, cfg] of cfgs) {
      const s = state.get(id)
      s.eps = cfg.epsSigma > 0 ? cfg.epsSigma * rng.normal(STREAMS.book, n, id, IDX.eps) : 0
    }
  }

  function getBookSnapshot(venueId) {
    return buildLadder(venueId, lastTick)
  }

  // Walk the book for a marketable order.
  //   order: { venueId, side: 'buy'|'sell', size }
  // 'buy'  = student lifts asks (e.g. buying to cover a short hedge)
  // 'sell' = student hits bids
  // Returns VWAP, filled size, slippage vs the venue mid, and the permanent
  // impact applied. A fraction φ of the impact feeds back into the true mid.
  function executeMarketable({ venueId, side, size }) {
    const cfg = cfgs.get(venueId)
    const ladder = buildLadder(venueId, lastTick)
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
    // Slippage per unit vs mid, signed as a COST (>0 = paid up / sold down).
    const slippagePerUnit = side === 'buy' ? vwap - midPx : midPx - vwap
    const slippage = slippagePerUnit * filled

    // Kyle-λ permanent impact (return space), signed with trade direction.
    const signed = side === 'buy' ? filled : -filled
    const impactReturn = cfg.kyleLambda * (signed / cfg.depthTop)
    // Persist as a price-space venue skew, and feed φ of it into the true mid.
    const s = state.get(venueId)
    s.skew += midPx * impactReturn
    if (cfg.phi !== 0 && impactReturn !== 0) {
      price.nudge(cfg.assetId, cfg.phi * impactReturn)
    }

    return {
      venueId,
      assetId: cfg.assetId,
      side,
      requestedSize: size,
      filledSize: filled,
      partial: remaining > 1e-12,
      vwap,
      mid: midPx,
      slippagePerUnit,
      slippage,
      impactReturn,
      consumed,
    }
  }

  function venueIds() {
    return [...cfgs.keys()]
  }

  return { getBookSnapshot, executeMarketable, mid, tick, venueIds }
}
