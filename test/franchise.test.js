// test/franchise.test.js — favor→arrival, pass, clustered toxic flow.
import { describe, it, expect } from 'vitest'
import { createSession, runFromSeed } from '../engine/session.js'

describe('pass action', () => {
  it('declines an RFQ, removes it from pending, and logs it', () => {
    const s = createSession({ seed: 4, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 5 } })
    // advance until an RFQ exists
    for (let i = 0; i < 200 && s.getState().pendingRfqs.length === 0; i++) s.tick()
    const rfq = s.getState().pendingRfqs[0]
    expect(rfq).toBeTruthy()
    s.passRfq(rfq.id)
    expect(s.getState().pendingRfqs.some((r) => r.id === rfq.id)).toBe(false)
    expect(s.getEventLog().some((e) => e.type === 'rfq_pass' && e.rfqId === rfq.id)).toBe(true)
  })
})

describe('favor → arrival', () => {
  it('a well-treated client comes back more often than a passed one', () => {
    // policy: quote tight to FAVOR_CLIENT, pass everyone else → its share of flow rises
    const { eventLog } = runFromSeed(6, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 25 } }, (state, s) => {
      const actions = []
      for (const r of state.pendingRfqs) {
        if (r.clientId === 'moonlad') {
          const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
          actions.push({ type: 'submitQuote', rfqId: r.id, bid: mid * 0.9999, ask: mid * 1.0001 }) // very tight
        } else {
          actions.push({ type: 'passRfq', rfqId: r.id })
        }
      }
      return actions
    })
    const rfqs = eventLog.filter((e) => e.type === 'rfq_new')
    const first = rfqs.slice(0, Math.floor(rfqs.length / 2))
    const last = rfqs.slice(Math.floor(rfqs.length / 2))
    const share = (arr) => arr.filter((e) => e.clientId === 'moonlad').length / Math.max(1, arr.length)
    expect(share(last)).toBeGreaterThan(share(first)) // favored client's share grows
  })
})

describe('clustered toxic flow (Hard)', () => {
  it('winning sharp toxic flow on Hard raises that name into a toxic cluster', () => {
    const s = createSession({ seed: 9, difficulty: 'hard', tier: 'pro', config: { sessionMinutes: 20 } })
    let sawAlert = false
    for (let i = 0; i < 4000 && !sawAlert; i++) {
      for (const r of s.getState().pendingRfqs) {
        const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
        s.submitQuote(r.id, { bid: mid * 0.99985, ask: mid * 1.00015 }) // tight → wins sharp flow
      }
      s.tick()
      if (s.getState().toxAlerts.length > 0) sawAlert = true
    }
    expect(sawAlert).toBe(true)
  })

  it('easy never clusters toxic flow', () => {
    const s = createSession({ seed: 9, difficulty: 'easy', tier: 'pro', config: { sessionMinutes: 10 } })
    for (let i = 0; i < 2000; i++) {
      for (const r of s.getState().pendingRfqs) {
        const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
        s.submitQuote(r.id, { bid: mid * 0.99985, ask: mid * 1.00015 })
      }
      s.tick()
    }
    expect(s.getState().toxAlerts).toHaveLength(0)
  })
})

describe('time-of-day plumbing', () => {
  it('the seed fixes a session start hour + label', () => {
    const s = createSession({ seed: 13, difficulty: 'easy', tier: 'pro' })
    expect(s.sessionClock.hourUTC).toBe(13)
    expect(typeof s.sessionClock.label).toBe('string')
    expect(s.getState().sessionClock.hourUTC).toBe(13)
  })
})
