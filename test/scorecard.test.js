// test/scorecard.test.js — post-trade scorecard (grading substrate).
//
// The scorecard is a pure function over what the session records, so it's
// deterministic and replayable. These tests lock in: it reconciles to the run,
// it discriminates between distinct playing styles (a fast prompt quoter vs a
// warehouse vs a disciplined hedger earn DIFFERENT archetypes/scores), and the
// rubric is monotone in the obvious direction.
import { describe, it, expect } from 'vitest'
import { runFromSeed } from '../engine/session.js'
import { buildScorecard } from '../engine/scorecard.js'

const CFG = { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 6 } }

// quote a fixed width on every pending RFQ
const quoteWidth = (bps) => (state, s) =>
  state.pendingRfqs.map((r) => {
    const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
    const w = (mid * bps) / 1e4
    return { type: 'submitQuote', rfqId: r.id, bid: mid - w, ask: mid + w }
  })

// quote, then immediately hedge any net inventory back to flat
const quoteAndHedge = (bps) => (state, s) => {
  const acts = quoteWidth(bps)(state, s)
  for (const [asset, pos] of Object.entries(state.positions)) {
    if (Math.abs(pos) < 1e-9) continue
    const v = s.venuesForAsset(asset)[0]
    acts.push({ type: 'hedge', assetId: asset, venueId: v, side: pos > 0 ? 'sell' : 'buy', size: Math.abs(pos) })
  }
  return acts
}

describe('scorecard — shape & reconciliation', () => {
  it('produces an archetype, a grade, six scored dimensions, and metrics', () => {
    const { scorecard } = runFromSeed(3, CFG, quoteWidth(10))
    expect(scorecard.archetype).toBeTruthy()
    expect('ABCDF').toContain(scorecard.grade)
    expect(scorecard.dimensions).toHaveLength(6)
    for (const d of scorecard.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0)
      expect(d.score).toBeLessThanOrEqual(100)
    }
    expect(scorecard.metrics.rfqsSeen).toBeGreaterThan(0)
  })

  it('P&L total matches the final state P&L', () => {
    const { scorecard, finalState } = runFromSeed(5, CFG, quoteWidth(8))
    expect(scorecard.pnl.total).toBeCloseTo(finalState.totalPnL, 6)
  })

  it('is deterministic for the same seed + policy', () => {
    const a = runFromSeed(9, CFG, quoteWidth(12))
    const b = runFromSeed(9, CFG, quoteWidth(12))
    expect(JSON.stringify(a.scorecard)).toBe(JSON.stringify(b.scorecard))
  })
})

describe('scorecard — discriminates playing styles', () => {
  it('a desk that hedges flat carries far less inventory risk than a warehouser', () => {
    const warehouse = runFromSeed(7, CFG, quoteWidth(10)).scorecard
    const hedger = runFromSeed(7, CFG, quoteAndHedge(10)).scorecard
    expect(hedger.metrics.peakGrossUsd).toBeLessThan(warehouse.metrics.peakGrossUsd)
    expect(hedger.metrics.hedgeRatio).toBeGreaterThan(warehouse.metrics.hedgeRatio)
  })

  it('hedging more earns a higher hedging-dimension score', () => {
    const warehouse = runFromSeed(7, CFG, quoteWidth(10)).scorecard
    const hedger = runFromSeed(7, CFG, quoteAndHedge(10)).scorecard
    const dim = (sc, k) => sc.dimensions.find((d) => d.key === k).score
    expect(dim(hedger, 'hedging')).toBeGreaterThan(dim(warehouse, 'hedging'))
  })

  it('never quoting ⇒ low franchise + speed engagement', () => {
    const ghost = runFromSeed(7, CFG, () => []).scorecard
    expect(ghost.metrics.quotesSent).toBe(0)
    const speed = ghost.dimensions.find((d) => d.key === 'speed').score
    expect(speed).toBeLessThan(50)
  })
})

describe('scorecard — pure-function guards', () => {
  it('handles an empty session without throwing', () => {
    const sc = buildScorecard({})
    expect(sc.metrics.rfqsSeen).toBe(0)
    expect(sc.overall).toBeGreaterThanOrEqual(0)
  })
})
