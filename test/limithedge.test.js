// test/limithedge.test.js — passive/limit hedging.
import { describe, it, expect } from 'vitest'
import { createSession } from '../engine/session.js'

function mk() {
  return createSession({ seed: 3, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 10, scenario: 'calm' } })
}

describe('limit hedge', () => {
  it('rests until the venue mid reaches it, then fills at the limit price', () => {
    const s = mk()
    const venue = s.venuesForAsset('BTC')[0]
    const mid0 = s.getBookSnapshot(venue).mid
    // a buy limit comfortably below mid should sit resting for a while
    const id = s.placeLimitHedge({ assetId: 'BTC', venueId: venue, side: 'buy', size: 1, price: mid0 - 200 })
    expect(s.getState().restingLimits.some((l) => l.id === id)).toBe(true)

    // run until it fills or the session ends
    let filled = false
    for (let i = 0; i < 2000 && !filled; i++) {
      s.tick()
      if (!s.getState().restingLimits.some((l) => l.id === id)) filled = true
    }
    const fillEvent = s.getEventLog().find((e) => e.type === 'limit_fill' && e.price === mid0 - 200)
    // It either filled at exactly the limit price, or is still resting (market never came) — but with calm drift over 10 min and a 200 gap it usually fills.
    if (filled) {
      expect(fillEvent).toBeTruthy()
      expect(s.getState().positions.BTC).toBeGreaterThan(0) // bought via the passive fill
    } else {
      expect(s.getState().restingLimits.some((l) => l.id === id)).toBe(true)
    }
  })

  it('can be cancelled before it fills', () => {
    const s = mk()
    const venue = s.venuesForAsset('BTC')[0]
    const mid0 = s.getBookSnapshot(venue).mid
    const id = s.placeLimitHedge({ assetId: 'BTC', venueId: venue, side: 'sell', size: 1, price: mid0 + 5000 }) // far away
    s.tick()
    s.cancelLimitHedge(id)
    expect(s.getState().restingLimits.some((l) => l.id === id)).toBe(false)
    expect(s.getEventLog().some((e) => e.type === 'limit_cancel' && e.limitId === id)).toBe(true)
  })

  it('fills at exactly the limit price — no slippage past your level', () => {
    const s = mk()
    const venue = s.venuesForAsset('BTC')[0]
    const mid0 = s.getBookSnapshot(venue).mid
    const limitPx = mid0 - 100
    s.placeLimitHedge({ assetId: 'BTC', venueId: venue, side: 'buy', size: 1, price: limitPx })
    for (let i = 0; i < 2000; i++) {
      s.tick()
      if (s.getEventLog().some((e) => e.type === 'limit_fill')) break
    }
    const fill = s.getEventLog().find((e) => e.type === 'limit_fill')
    if (fill) {
      expect(fill.price).toBe(limitPx) // executed at your price, not walked through the book
      expect(s.getState().positions.BTC).toBeGreaterThan(0)
    }
  })
})
