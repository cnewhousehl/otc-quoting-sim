// test/pnl.test.js — M3 P&L decomposition + the exact reconciliation identity.
import { describe, it, expect } from 'vitest'
import { createPnL } from '../engine/pnl.js'

describe('pnl — component signs', () => {
  it('captures gross spread on a client fill (client buys at the ask)', () => {
    const p = createPnL()
    p.setMark('BTC', 65000)
    // Client buys 2 @ 65010 (student sells above mid) → +20 gross spread.
    p.onClientFill({ assetId: 'BTC', clientBuys: true, size: 2, price: 65010 })
    expect(p.snapshot().decomposition.grossSpread).toBeCloseTo(20, 9)
    expect(p.snapshot().positions.BTC).toBe(-2) // student is short
  })

  it('captures gross spread when the client sells at the bid', () => {
    const p = createPnL()
    p.setMark('BTC', 65000)
    // Client sells 2 @ 64990 (student buys below mid) → +20 gross spread.
    p.onClientFill({ assetId: 'BTC', clientBuys: false, size: 2, price: 64990 })
    expect(p.snapshot().decomposition.grossSpread).toBeCloseTo(20, 9)
    expect(p.snapshot().positions.BTC).toBe(2)
  })

  it('records hedge slippage as a positive cost', () => {
    const p = createPnL()
    p.setMark('BTC', 65000)
    // Buy 2 @ vwap 65007 vs mid 65000 → slippage 14.
    p.onHedge({ assetId: 'BTC', buy: true, size: 2, vwap: 65007 })
    expect(p.snapshot().decomposition.hedgeSlippage).toBeCloseTo(14, 9)
  })

  it('splits a mid move into InvMtM (r_GBM) and AdvSel (r_tox)', () => {
    const p = createPnL()
    p.setMark('BTC', 65000)
    p.onClientFill({ assetId: 'BTC', clientBuys: false, size: 1, price: 65000 }) // long 1, no spread
    const rGBM = 0.001
    const rTox = -0.004
    const midAfter = 65000 * Math.exp(rGBM + rTox)
    p.onTick({ BTC: { midBefore: 65000, midAfter, rGBM } })
    const d = p.snapshot().decomposition
    expect(d.invMtM).toBeGreaterThan(0) // GBM up
    expect(d.advSel).toBeLessThan(0) // toxic down hurts the long
    // the two parts reconstruct the full move on the position
    expect(d.invMtM + d.advSel).toBeCloseTo(midAfter - 65000, 9)
  })
})

describe('pnl — reconciliation identity (the M3 gate)', () => {
  it('equity change equals the component sum to 1e−9 over a mixed session', () => {
    const p = createPnL()
    const assets = ['BTC', 'ETH']
    const mids = { BTC: 65000, ETH: 3200 }
    for (const a of assets) p.setMark(a, mids[a])
    const equity0 = p.equity()
    expect(equity0).toBeCloseTo(0, 12) // flat, marked, cash 0

    // A messy sequence of fills, hedges, fees, and mid moves on both assets.
    p.onClientFill({ assetId: 'BTC', clientBuys: true, size: 3, price: 65012, fee: 1.5 })
    p.onClientFill({ assetId: 'ETH', clientBuys: false, size: 10, price: 3198, fee: 0.8 })
    p.onHedge({ assetId: 'BTC', buy: true, size: 2, vwap: 65020, fee: 0.5 })
    p.onClientFill({ assetId: 'ETH', clientBuys: true, size: 4, price: 3203 })

    // tick 1: BTC up via GBM, toxic down; ETH flat GBM, toxic up
    let bMid = mids.BTC
    let eMid = mids.ETH
    {
      const rGBM = 0.0009, rTox = -0.0031
      const after = bMid * Math.exp(rGBM + rTox)
      p.onTick({ BTC: { midBefore: bMid, midAfter: after, rGBM } })
      bMid = after
    }
    {
      const rGBM = 0.0, rTox = 0.0025
      const after = eMid * Math.exp(rGBM + rTox)
      p.onTick({ ETH: { midBefore: eMid, midAfter: after, rGBM } })
      eMid = after
    }

    p.onHedge({ assetId: 'ETH', buy: false, size: 6, vwap: eMid - 1.2, fee: 0.4 })

    // tick 2: another combined move on BTC
    {
      const rGBM = -0.0015, rTox = -0.0008
      const after = bMid * Math.exp(rGBM + rTox)
      p.onTick({ BTC: { midBefore: bMid, midAfter: after, rGBM } })
      bMid = after
    }

    const snap = p.snapshot()
    const equity1 = snap.equity
    const total = snap.totalPnL

    // The decomposition reconstructs the realized total exactly.
    const d = snap.decomposition
    const recomposed = d.grossSpread + d.invMtM + d.advSel - d.hedgeSlippage - d.fees
    expect(recomposed).toBeCloseTo(total, 9)

    // And total P&L equals the actual change in marked equity — to 1e−9 relative.
    const diff = Math.abs(equity1 - equity0 - total)
    expect(diff).toBeLessThan(1e-9 * (Math.abs(total) + 1))
  })
})
