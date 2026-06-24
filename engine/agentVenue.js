// engine/agentVenue.js
//
// Phase-1b agent-MM venue (PLAN.md §1.8, M11). A population of maker agents post
// limit orders into a price-time-priority matching book; the aggregate IS the
// order book, behind the SAME venue interface as the parametric perp venue
// (engine/perpVenue.js), so it drops into engine/book.js with no caller changes.
//
// Emergent (not parametric):
//   - spread/depth come from the makers' quotes;
//   - a maker that gets adversely filled widens + skews to offload → toxicity &
//     skew emerge; makers re-post each tick → resilience emerges;
//   - makers nudge their perceived fair toward aggressive flow (they infer the
//     taker is informed) → Kyle-λ-style permanent impact emerges;
//   - any crossed quotes match same-tick → no persistent crossed book.

import { createMaker } from './maker.js'

export function createAgentVenue({ rng, price, dt, cfg }) {
  const makers = cfg.makers.map((m) => createMaker({ ...m, dt }))
  const makerById = new Map(makers.map((m) => [m.id, m]))
  let bids = [] // resting orders, sorted best→worst { price, size, makerId }
  let asks = []
  let stress = 0

  function rebuild(n) {
    const M = price.mid(cfg.assetId)
    for (const mk of makers) mk.reprice(rng, n, M, dt)
    bids = []
    asks = []
    for (const mk of makers) {
      const q = mk.quote()
      bids.push(...q.bids)
      asks.push(...q.asks)
    }
    bids.sort((a, b) => b.price - a.price)
    asks.sort((a, b) => a.price - b.price)
    // Uncross: while best bid ≥ best ask, the two makers trade (crossing is a
    // trade, not a bug) until the book is uncrossed.
    let guard = 0
    while (bids.length && asks.length && bids[0].price >= asks[0].price && guard++ < 5000) {
      const b = bids[0]
      const a = asks[0]
      const take = Math.min(b.size, a.size)
      makerById.get(b.makerId)?.onFill('bought', take)
      makerById.get(a.makerId)?.onFill('sold', take)
      b.size -= take
      a.size -= take
      if (b.size <= 1e-9) bids.shift()
      if (a.size <= 1e-9) asks.shift()
    }
  }

  const bestBid = () => (bids.length ? bids[0].price : price.mid(cfg.assetId))
  const bestAsk = () => (asks.length ? asks[0].price : price.mid(cfg.assetId))
  const mid = () => (bestBid() + bestAsk()) / 2

  // Stress widens the displayed/executable book around the mid and thins it.
  function withStress(levels, m) {
    if (stress <= 0) return levels.map((l) => ({ price: l.price, size: l.size, makerId: l.makerId }))
    const sp = 1 + 2.2 * stress
    const dp = 1 + 0.7 * stress
    return levels.map((l) => ({ price: m + (l.price - m) * sp, size: l.size / dp, makerId: l.makerId }))
  }

  function getBookSnapshot() {
    const m = mid()
    return { mid: m, spread: bestAsk() - bestBid(), bids: withStress(bids, m), asks: withStress(asks, m) }
  }

  // Walk the resting opposite side; fills update the makers whose orders were
  // hit (they take on inventory → skew/widen next tick → emergent impact). If the
  // clip is bigger than the visible book, it keeps filling against a synthetic
  // deep tail at progressively worse prices (a real venue always has SOME deeper
  // liquidity) so a marketable hedge ALWAYS fills — you get all you swept, just
  // deeper. The displayed book (getBookSnapshot) stays finite/realistic.
  function sweep(side, size, mutate) {
    const m = mid()
    const sign = side === 'buy' ? 1 : -1
    const levels = withStress(side === 'buy' ? asks : bids, m)
    let remaining = size
    let cost = 0
    let filled = 0
    let restDepth = 0
    for (const lvl of levels) {
      restDepth += lvl.size
      if (remaining <= 1e-9) continue
      const take = Math.min(remaining, lvl.size)
      cost += take * lvl.price
      filled += take
      remaining -= take
      if (mutate) makerById.get(lvl.makerId)?.onFill(side === 'buy' ? 'sold' : 'bought', take)
    }
    if (remaining > 1e-9) {
      // tail: chunks beyond the book, each ~3 bps worse than the last
      const worst = levels.length ? levels[levels.length - 1].price : m + sign * m * 0.0003
      const step = m * 0.0003
      const chunk = Math.max(restDepth * 0.3, size * 0.05)
      let j = 0
      while (remaining > 1e-9 && j < 200000) {
        const take = Math.min(remaining, chunk)
        cost += take * (worst + sign * step * (j + 1))
        filled += take
        remaining -= take
        j++
      }
    }
    return { m, filled, vwap: filled > 0 ? cost / filled : m, partial: remaining > 1e-6 }
  }

  function executeMarketable({ side, size }) {
    const { m, filled, vwap, partial } = sweep(side, size, true)
    const slippagePerUnit = side === 'buy' ? vwap - m : m - vwap
    return { side, requestedSize: size, filledSize: filled, partial, vwap, mid: m, slippagePerUnit, slippage: slippagePerUnit * filled, impactReturn: 0 }
  }

  function estimateCost(side, size) {
    const { m, filled, vwap, partial } = sweep(side, size, false)
    return { vwap, filledSize: filled, partial, slipBps: (Math.abs(vwap - m) / m) * 1e4, mid: m }
  }

  function tick(n) {
    rebuild(n)
  }

  const setStress = (s) => {
    stress = s
  }
  // Aggressive flow on a sibling venue makes these makers wary (widen) too.
  function observeExternalFlow(signed) {
    const mag = Math.min(0.5, Math.abs(signed) / (cfg.makers[0]?.invLimit ?? 1))
    for (const mk of makers) mk.onFill(signed > 0 ? 'sold' : 'bought', mag * 0.001)
  }

  return { id: cfg.id, assetId: cfg.assetId, type: 'agent', tier: cfg.tier, mid, getBookSnapshot, executeMarketable, estimateCost, tick, observeExternalFlow, setStress }
}
