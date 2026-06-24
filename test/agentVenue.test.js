// test/agentVenue.test.js — M11 / PLAN.md §1.8 emergent-book invariants (Q7.11).
//
// The agent-MM venue isn't tuned with spread/depth/impact knobs; those are meant
// to EMERGE from the maker population. These tests lock in that the emergence is
// well-behaved and lands in the same ballpark as the parametric venue, so the
// 'agent' book is a safe drop-in behind the same interface:
//   - the book is uncrossed (best bid < best ask) and spread sits in a band;
//   - it has real two-sided depth;
//   - sweeping the book costs more for bigger clips and always fills (sweep-to-fill);
//   - sustained one-way flow thins the hit side and shifts the mid that way
//     (emergent toxicity + Kyle-λ impact), then the book heals after flow stops;
//   - same seed ⇒ identical book (determinism via the `maker` sub-stream).
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createPriceProcess } from '../engine/price.js'
import { createBook } from '../engine/book.js'
import { buildAgentVenues } from '../config/venues.js'

const DT = 0.25
const ASSETS = [{ id: 'BTC', m0: 65000, sigma: 0.00005, regime: 'flat', driftMag: 0, anchor: 65000, corr: 0, jumpIntensity: 0, jumpSigma: 0 }]

function makeBook(seed = 7) {
  const rng = createRng(seed)
  const price = createPriceProcess({ rng, dt: DT, assets: ASSETS })
  const venues = buildAgentVenues([{ id: 'BTC', refPrice: 65000, venues: ['binance-perp', 'bybit-perp', 'uni-amm'] }])
  const book = createBook({ rng, price, venues, dt: DT })
  book.tick(0)
  return { book, price, t1: 'binance-perp:BTC' }
}

function warm(book, ticks = 12) {
  for (let n = 1; n <= ticks; n++) book.tick(n)
}

describe('M11 — agent-MM book emerges well-formed', () => {
  it('the book is uncrossed and the spread sits in a sane band', () => {
    const { book, t1 } = makeBook()
    warm(book)
    const s = book.getBookSnapshot(t1)
    const bestBid = s.bids[0].price
    const bestAsk = s.asks[0].price
    expect(bestAsk).toBeGreaterThan(bestBid) // no persistent crossed book
    const halfSpreadBps = ((bestAsk - bestBid) / 2 / s.mid) * 1e4
    expect(halfSpreadBps).toBeGreaterThan(0.1)
    expect(halfSpreadBps).toBeLessThan(15) // T1 stays tight-ish even with skew
  })

  it('has real two-sided depth from the maker population', () => {
    const { book, t1 } = makeBook()
    warm(book)
    const s = book.getBookSnapshot(t1)
    expect(s.bids.length).toBeGreaterThan(3)
    expect(s.asks.length).toBeGreaterThan(3)
    const topNotional = s.asks[0].size * s.asks[0].price
    expect(topNotional).toBeGreaterThan(0)
  })

  it('sweeps to fill: bigger clips fill fully and cost more', () => {
    const a = makeBook()
    warm(a.book)
    const mid = a.book.getBookSnapshot(a.t1).mid
    const small = a.book.estimateCost(a.t1, 'buy', 1e6 / mid)
    const b = makeBook()
    warm(b.book)
    const big = b.book.estimateCost(b.t1, 'buy', 8e6 / mid)
    expect(small.partial).toBe(false)
    expect(big.partial).toBe(false)
    expect(big.filledSize).toBeCloseTo(8e6 / mid, 4)
    expect(big.slipBps).toBeGreaterThan(small.slipBps) // deeper sweep ⇒ worse VWAP
  })
})

describe('M11 — toxicity, impact and resilience emerge', () => {
  it('sustained one-way buying thins the ask side and lifts the mid, then heals', () => {
    const { book, t1 } = makeBook()
    warm(book)
    const before = book.getBookSnapshot(t1)
    const midBefore = before.mid
    const askDepthBefore = before.asks.slice(0, 3).reduce((x, l) => x + l.size, 0)

    // hammer the offer for several ticks (informed-looking flow)
    for (let n = 13; n <= 22; n++) {
      book.executeMarketable({ venueId: t1, side: 'buy', size: 2e6 / midBefore })
      book.tick(n)
    }
    const after = book.getBookSnapshot(t1)
    expect(after.mid).toBeGreaterThan(midBefore) // makers repriced up (Kyle-λ)
    const askDepthAfter = after.asks.slice(0, 3).reduce((x, l) => x + l.size, 0)
    expect(askDepthAfter).toBeLessThan(askDepthBefore) // hit side thinned

    // stop trading; let the makers re-post and heal
    for (let n = 23; n <= 60; n++) book.tick(n)
    const healed = book.getBookSnapshot(t1)
    const askDepthHealed = healed.asks.slice(0, 3).reduce((x, l) => x + l.size, 0)
    expect(askDepthHealed).toBeGreaterThan(askDepthAfter) // depth came back
  })

  it('is deterministic: same seed ⇒ identical inside market', () => {
    const a = makeBook(99)
    const b = makeBook(99)
    warm(a.book)
    warm(b.book)
    const sa = a.book.getBookSnapshot(a.t1)
    const sb = b.book.getBookSnapshot(b.t1)
    expect(sa.bids[0].price).toBe(sb.bids[0].price)
    expect(sa.asks[0].price).toBe(sb.asks[0].price)
  })
})
