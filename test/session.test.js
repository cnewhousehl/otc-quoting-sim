// test/session.test.js — M9 session API, difficulty wiring, replay determinism.
import { describe, it, expect } from 'vitest'
import { createSession, runFromSeed } from '../engine/session.js'

// A deterministic scripted policy: quote a fixed-width two-way around the venue
// best on every pending RFQ, refresh occasionally, and flat-hedge big inventory.
function scriptedPolicy(state, s) {
  const actions = []
  for (const rfq of state.pendingRfqs) {
    const venues = s.venuesForAsset(rfq.assetId)
    if (!venues.length) continue
    const mid = s.getBookSnapshot(venues[0]).mid
    const w = mid * 0.0006
    actions.push({ type: 'submitQuote', rfqId: rfq.id, bid: mid - w, ask: mid + w })
  }
  return actions
}

describe('session — construction & gating', () => {
  it('gates Hard down to medium on the free tier', () => {
    const s = createSession({ seed: 1, difficulty: 'hard', tier: 'free' })
    expect(s.difficulty).toBe('medium')
    expect(s.gated.some((g) => g.feature === 'difficulty')).toBe(true)
  })

  it('allows Hard on a licensed tier', () => {
    const s = createSession({ seed: 1, difficulty: 'hard', tier: 'pro' })
    expect(s.difficulty).toBe('hard')
    expect(s.gated).toHaveLength(0)
  })

  it('exposes venues, with DEX-only routing for esoteric names', () => {
    const s = createSession({ seed: 1, difficulty: 'medium', tier: 'pro' })
    expect(s.venuesForAsset('WIF')).toEqual(['uni-amm:WIF'])
    expect(s.venueInfo('uni-amm:WIF').type).toBe('amm')
  })
})

describe('session — live loop', () => {
  it('produces RFQs, quotes, and fills over a short run', () => {
    const s = createSession({ seed: 3, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 5 } })
    for (let i = 0; i < 400; i++) {
      for (const a of scriptedPolicy(s.getState(), s)) s.submitQuote(a.rfqId, { bid: a.bid, ask: a.ask })
      s.tick()
    }
    const log = s.getEventLog()
    const types = new Set(log.map((e) => e.type))
    expect(types.has('rfq_new')).toBe(true)
    expect(types.has('quote_submit')).toBe(true)
    expect(types.has('fill')).toBe(true)
  })

  it('respects the pending-RFQ cap (never more pending than the difficulty allows)', () => {
    const s = createSession({ seed: 5, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 5 } })
    let maxPending = 0
    for (let i = 0; i < 400; i++) {
      // never quote → pending should saturate at the cap, not blow past it
      maxPending = Math.max(maxPending, s.getState().pendingRfqs.length)
      s.tick()
    }
    expect(maxPending).toBeLessThanOrEqual(5) // medium maxPendingRFQs
    expect(maxPending).toBeGreaterThan(0)
  })

  it('P&L decomposition reconciles to equity over a full scripted run', () => {
    const { finalState } = runFromSeed(7, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 3 } }, scriptedPolicy)
    const d = finalState.decomposition
    const recomposed = d.grossSpread + d.invMtM + d.advSel - d.hedgeSlippage - d.fees
    expect(recomposed).toBeCloseTo(finalState.totalPnL, 6)
  })
})

describe('session — replay determinism (the grading property)', () => {
  it('same seed + same policy ⇒ byte-identical event log', () => {
    const a = runFromSeed(42, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 4 } }, scriptedPolicy)
    const b = runFromSeed(42, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 4 } }, scriptedPolicy)
    expect(JSON.stringify(a.eventLog)).toBe(JSON.stringify(b.eventLog))
  })

  it('different seed ⇒ different log', () => {
    const a = runFromSeed(1, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 4 } }, scriptedPolicy)
    const b = runFromSeed(2, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 4 } }, scriptedPolicy)
    expect(JSON.stringify(a.eventLog)).not.toBe(JSON.stringify(b.eventLog))
  })
})

describe('session — difficulty wiring', () => {
  it('hard brings more toxic RFQs than easy', () => {
    const toxShare = (level) => {
      const { eventLog } = runFromSeed(9, { difficulty: level, tier: 'pro', config: { sessionMinutes: 8 } }, scriptedPolicy)
      const rfqs = eventLog.filter((e) => e.type === 'rfq_new')
      return rfqs.filter((e) => e.isToxic).length / rfqs.length
    }
    expect(toxShare('hard')).toBeGreaterThan(toxShare('easy'))
  })
})
