// engine/pnl.js
//
// Positions, cash, blotter, and the P&L decomposition (PLAN.md §1.1 pnl.js, Q3):
//
//   Realized = GrossSpread + InvMtM + AdvSel + HedgeSlippage − Fees
//
// where (signs as accumulated here):
//   GrossSpread    edge captured filling a client vs the true mid at fill time
//   HedgeSlippage  cost (≥0) of hedging into the book vs the true mid
//   InvMtM         warehoused-inventory mark-to-market from the r_GBM mid move
//   AdvSel         warehoused-inventory mark from the r_tox (toxic) mid move
//   Fees           explicit trading fees
//
// The identity is EXACT (to float epsilon): total equity (cash + inventory
// marked at the true mid) changes by exactly the sum of the components, because
// each event contributes its own ΔE. This is the unit-tested invariant the
// grader relies on. Inventory is marked at the hidden TRUE mid M_t throughout so
// the books' basis/spread can't leak into the reconciliation.

export function createPnL() {
  const positions = new Map() // assetId -> signed position q
  const marks = new Map() // assetId -> true mid used for marking
  let cash = 0
  const comp = { grossSpread: 0, hedgeSlippage: 0, invMtM: 0, advSel: 0, fees: 0 }
  const blotter = []
  const hedgeLog = []

  const pos = (id) => positions.get(id) ?? 0
  const mark = (id) => marks.get(id) ?? 0

  // Seed (or reset) the mark for an asset — call before booking trades so equity
  // is defined and GrossSpread/HedgeSlippage use the correct fair mid.
  function setMark(assetId, mid) {
    marks.set(assetId, mid)
  }

  // A client trades against the student's quote.
  //   clientBuys: true if the client buys (student SELLS / goes shorter)
  //   price: the (possibly stale) quoted price the client executed at
  function onClientFill({ assetId, clientBuys, size, price, fee = 0, meta = null }) {
    const m = mark(assetId)
    const dq = clientBuys ? -size : size // student takes the opposite side
    const tradeCash = clientBuys ? price * size : -price * size
    const gross = tradeCash + m * dq // = size·|price−mid| in the favorable direction
    comp.grossSpread += gross
    comp.fees += fee
    cash += tradeCash - fee
    positions.set(assetId, pos(assetId) + dq)
    blotter.push({
      kind: 'client',
      assetId,
      side: clientBuys ? 'sell' : 'buy', // student's side
      size,
      price,
      fairMid: m,
      grossSpread: gross,
      fee,
      ...(meta || {}),
    })
  }

  // The student hedges into a venue book at a realized VWAP.
  //   buy: true if the student buys (lifts asks)
  function onHedge({ assetId, buy, size, vwap, fee = 0, meta = null }) {
    const m = mark(assetId)
    const dq = buy ? size : -size
    const tradeCash = buy ? -vwap * size : vwap * size
    const slip = -(tradeCash + m * dq) // ≥0 cost vs true mid
    comp.hedgeSlippage += slip
    comp.fees += fee
    cash += tradeCash - fee
    positions.set(assetId, pos(assetId) + dq)
    hedgeLog.push({ assetId, side: buy ? 'buy' : 'sell', size, vwap, fairMid: m, slippage: slip, fee, ...(meta || {}) })
  }

  // Mark to a new tick. perAsset maps assetId -> { midBefore, midAfter, rGBM }.
  // The mid move is split EXACTLY into r_GBM and r_tox parts:
  //   dInv = q · midBefore · (e^rGBM − 1)
  //   dAdv = q · (midAfter − midBefore · e^rGBM)
  // so dInv + dAdv = q · (midAfter − midBefore).
  function onTick(perAsset) {
    for (const id of Object.keys(perAsset)) {
      const { midBefore, midAfter, rGBM } = perAsset[id]
      const q = pos(id)
      if (q !== 0) {
        const gbmMid = midBefore * Math.exp(rGBM)
        comp.invMtM += q * (gbmMid - midBefore)
        comp.advSel += q * (midAfter - gbmMid)
      }
      marks.set(id, midAfter)
    }
  }

  // Equity = cash + inventory marked at the true mid.
  function equity() {
    let e = cash
    for (const [id, q] of positions) e += q * mark(id)
    return e
  }

  // Total P&L from the decomposition (must equal equity() − initialEquity).
  function totalPnL() {
    return comp.grossSpread + comp.invMtM + comp.advSel - comp.hedgeSlippage - comp.fees
  }

  function snapshot() {
    const positionsOut = {}
    let usdDelta = 0
    for (const [id, q] of positions) {
      positionsOut[id] = q
      usdDelta += q * mark(id)
    }
    return {
      cash,
      positions: positionsOut,
      usdDelta,
      equity: equity(),
      totalPnL: totalPnL(),
      decomposition: { ...comp },
      blotter: blotter.slice(),
      hedgeLog: hedgeLog.slice(),
    }
  }

  return { setMark, onClientFill, onHedge, onTick, equity, totalPnL, snapshot, _comp: comp }
}
