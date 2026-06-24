// test/book.test.js — M3 book interface, VWAP/impact monotonicity, φ feedback.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createPriceProcess } from '../engine/price.js'
import { createBook } from '../engine/book.js'

function setup({ seed = 1, venue = {} } = {}) {
  const rng = createRng(seed)
  const price = createPriceProcess({
    rng,
    dt: 0.25,
    assets: [{ id: 'BTC', m0: 65000, sigma: 0.0 }], // sigma 0 so the book mid is stable for asserts
  })
  const book = createBook({
    rng,
    price,
    venues: [
      {
        id: 'V1',
        assetId: 'BTC',
        basis: 0,
        halfSpread: 5,
        levelStep: 5,
        depthTop: 10,
        k0: 5,
        numLevels: 40,
        kyleLambda: 0.0,
        phi: 0.0,
        ...venue,
      },
    ],
  })
  book.tick(0)
  return { rng, price, book }
}

describe('book — snapshot & interface', () => {
  it('produces a symmetric ladder around the mid', () => {
    const { book } = setup()
    const snap = book.getBookSnapshot('V1')
    expect(snap.mid).toBeCloseTo(65000, 6)
    expect(snap.spread).toBeCloseTo(10, 6)
    expect(snap.asks[0].price).toBeCloseTo(65005, 6)
    expect(snap.bids[0].price).toBeCloseTo(64995, 6)
    // depth decays with level
    expect(snap.asks[0].size).toBeGreaterThan(snap.asks[5].size)
  })

  it('exposes mid() = M_t + basis', () => {
    const { book } = setup({ venue: { basis: 12 } })
    expect(book.mid('V1')).toBeCloseTo(65012, 6)
  })
})

describe('book — walk-the-book VWAP', () => {
  it('small buy fills at the top of book', () => {
    const { book } = setup()
    const r = book.executeMarketable({ venueId: 'V1', side: 'buy', size: 5 })
    expect(r.filledSize).toBe(5)
    expect(r.partial).toBe(false)
    expect(r.vwap).toBeCloseTo(65005, 6) // entirely within level 0
    expect(r.slippagePerUnit).toBeCloseTo(5, 6) // = halfSpread
  })

  it('bigger clip ⇒ worse VWAP (impact monotonic)', () => {
    const sizes = [5, 20, 50, 120]
    let prevVwap = -Infinity
    let prevSlip = -Infinity
    for (const size of sizes) {
      const { book } = setup()
      const r = book.executeMarketable({ venueId: 'V1', side: 'buy', size })
      expect(r.vwap).toBeGreaterThan(prevVwap)
      expect(r.slippagePerUnit).toBeGreaterThan(prevSlip - 1e-9)
      prevVwap = r.vwap
      prevSlip = r.slippagePerUnit
    }
  })

  it('sell side is the mirror image (hits bids, slippage ≥ 0)', () => {
    const { book } = setup()
    const r = book.executeMarketable({ venueId: 'V1', side: 'sell', size: 30 })
    expect(r.vwap).toBeLessThan(65000)
    expect(r.slippagePerUnit).toBeGreaterThan(0)
  })

  it('a marketable order always fills the full size by sweeping the book (no pulled liquidity)', () => {
    const big = setup({ venue: { numLevels: 3, depthTop: 4, k0: 100 } }).book.executeMarketable({ venueId: 'V1', side: 'buy', size: 1000 })
    expect(big.partial).toBe(false)
    expect(big.filledSize).toBeCloseTo(1000, 3)
    // and sweeping deep costs a worse VWAP than a small clip
    const small = setup({ venue: { numLevels: 3, depthTop: 4, k0: 100 } }).book.executeMarketable({ venueId: 'V1', side: 'buy', size: 5 })
    expect(big.vwap).toBeGreaterThan(small.vwap)
  })
})

describe('book — Kyle-λ impact & φ feedback', () => {
  it('a buy applies permanent impact that raises the venue mid', () => {
    const { book } = setup({ venue: { kyleLambda: 0.5, phi: 0.0 } })
    const before = book.mid('V1')
    book.executeMarketable({ venueId: 'V1', side: 'buy', size: 20 })
    expect(book.mid('V1')).toBeGreaterThan(before) // skew shifted up
  })

  it('φ feeds a fraction of impact back into the TRUE mid', () => {
    const phi = 0.3
    const lambda = 0.5
    const { price, book } = setup({ venue: { kyleLambda: lambda, phi } })
    const trueBefore = price.mid('BTC')
    const r = book.executeMarketable({ venueId: 'V1', side: 'buy', size: 20 })
    const trueAfter = price.mid('BTC')
    // true mid moved up by φ·impactReturn (in return space → multiplicative)
    const expected = trueBefore * Math.exp(phi * r.impactReturn)
    expect(trueAfter).toBeCloseTo(expected, 6)
    expect(trueAfter).toBeGreaterThan(trueBefore)
  })

  it('no φ ⇒ true mid is untouched by hedging', () => {
    const { price, book } = setup({ venue: { kyleLambda: 0.5, phi: 0.0 } })
    const before = price.mid('BTC')
    book.executeMarketable({ venueId: 'V1', side: 'buy', size: 20 })
    expect(price.mid('BTC')).toBeCloseTo(before, 9)
  })
})
