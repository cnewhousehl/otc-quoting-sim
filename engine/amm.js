// engine/amm.js
//
// Constant-product (x·y=k) DEX venue (M7), implementing the same venue handler
// interface as the perp ladder so it drops into the market behind `book`.
//
// Unlike the order-book venues, the fill price is EXACT and known up front from
// the curve. Reserves are re-anchored to the true mid M_t each tick (continuous
// arbitrage), so slippage comes purely from trade size vs pool depth: a small
// pool means large slippage for size — the realistic DEX trade-off. A swap fee
// acts like the venue's half-spread. Esoteric coins that only trade on DEXes
// route here (see config/venues.js), and their wider fills are why a client is
// content with a wider RFQ on those names.

export function createAmmVenue({ price, cfg }) {
  // cfg: { id, assetId, poolBase (Rx, base-token reserve), feeBps, sampleLevels }
  const feeBps = cfg.feeBps ?? 30 // 0.30% default
  const fee = feeBps / 1e4
  const Rx = cfg.poolBase // base reserve; quote reserve Ry = Rx · M (price = M)
  const sampleLevels = cfg.sampleLevels ?? 20

  const reserves = () => {
    const M = price.mid(cfg.assetId)
    return { Rx, Ry: Rx * M, M }
  }

  const mid = () => price.mid(cfg.assetId)

  // Exact constant-product execution. buy: pay quote for dx base; sell: receive
  // quote for dx base. Always "fills" up to ~the pool, with slippage from x·y=k.
  function executeMarketable({ side, size }) {
    const { Rx: x, Ry: y, M } = reserves()
    let dx = size
    let partial = false
    if (dx >= x * 0.98) {
      dx = x * 0.98 // cannot drain the pool
      partial = true
    }
    let vwap
    if (side === 'buy') {
      const dyOut = (y * dx) / (x - dx) // quote paid (pre-fee)
      vwap = (dyOut * (1 + fee)) / dx
    } else {
      const dyIn = (y * dx) / (x + dx) // quote received (pre-fee)
      vwap = (dyIn * (1 - fee)) / dx
    }
    const slippagePerUnit = side === 'buy' ? vwap - M : M - vwap
    return {
      side,
      requestedSize: size,
      filledSize: dx,
      partial,
      vwap,
      mid: M,
      slippagePerUnit,
      slippage: slippagePerUnit * dx,
      impactReturn: 0, // arb re-anchors reserves each tick; no persistent venue impact
    }
  }

  // Synthesize a pseudo-ladder by sampling the curve, for the UI. Each "level"
  // is the marginal cost of an additional clip; spread = 2·fee around M.
  function getBookSnapshot() {
    const { Rx: x, Ry: y, M } = reserves()
    const step = x * 0.01
    const bids = []
    const asks = []
    for (let k = 0; k < sampleLevels; k++) {
      const lo = step * k
      const hi = step * (k + 1)
      // marginal quote over (lo, hi] on each side, fee-adjusted, per base unit
      const askPx = (((y * hi) / (x - hi) - (y * lo) / (x - lo)) * (1 + fee)) / step
      const bidPx = (((y * lo) / (x + lo) - (y * hi) / (x + hi)) * (1 - fee)) / step * -1
      asks.push({ price: askPx, size: step })
      bids.push({ price: bidPx, size: step })
    }
    return { mid: M, spread: asks[0].price - bids[0].price, bids, asks }
  }

  function tick() {
    // stateless per tick — reserves re-anchor to M_t on read
  }

  return { id: cfg.id, assetId: cfg.assetId, type: 'amm', tier: cfg.tier ?? 'DEX', mid, getBookSnapshot, executeMarketable, tick }
}
