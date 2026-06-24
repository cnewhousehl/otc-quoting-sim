// test/venues.test.js — M7 multi-venue: tiers, AMM exact slippage, staleness,
// asset availability, and the toxicity reaction wired through a perp venue.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createPriceProcess, REGIMES } from '../engine/price.js'
import { createBook } from '../engine/book.js'
import { buildVenues, venuesForAsset, isDexOnly, ASSET_UNIVERSE } from '../config/venues.js'

function market({ seed = 1, regime = REGIMES.flat, driftMag = 0 } = {}) {
  const rng = createRng(seed)
  const assets = ASSET_UNIVERSE.map((a) => ({ id: a.id, m0: a.refPrice, sigma: a.sigma, regime, driftMag, driftPerTick: 0 }))
  const price = createPriceProcess({ rng, dt: 0.25, assets })
  const book = createBook({ rng, price, venues: buildVenues(), dt: 0.25 })
  book.tick(0)
  return { rng, price, book }
}

describe('venues — availability', () => {
  it('majors list T1/T2/DEX; esoteric coins are DEX-only', () => {
    expect(venuesForAsset('BTC')).toContain('binance-perp')
    expect(isDexOnly('BTC')).toBe(false)
    expect(venuesForAsset('WIF')).toEqual(['uni-amm'])
    expect(isDexOnly('WIF')).toBe(true)
  })

  it('the market only has DEX venues for a DEX-only coin', () => {
    const { book } = market()
    const wifVenues = book.venuesForAsset('WIF')
    expect(wifVenues).toEqual(['uni-amm:WIF'])
    expect(book.venueInfo('uni-amm:WIF').type).toBe('amm')
  })
})

describe('venues — tier profiles', () => {
  it('T1 quotes a tighter spread than T2 on the same asset', () => {
    const { book } = market()
    const t1 = book.getBookSnapshot('binance-perp:BTC').spread
    const t2 = book.getBookSnapshot('bybit-perp:BTC').spread
    expect(t1).toBeLessThan(t2)
  })

  it('T1 is deeper at the top of book than T2', () => {
    const { book } = market()
    const t1 = book.getBookSnapshot('binance-perp:BTC').asks[0].size
    const t2 = book.getBookSnapshot('bybit-perp:BTC').asks[0].size
    expect(t1).toBeGreaterThan(t2)
  })
})

describe('venues — T2 staleness lag', () => {
  it('T2 mid lags the true mid under a trend while T1 tracks it', () => {
    const { price, book } = market({ regime: REGIMES.up, driftMag: 0.0008, seed: 3 })
    for (let n = 1; n <= 60; n++) {
      price.step(n)
      book.tick(n)
    }
    const trueMid = price.mid('BTC')
    const t1 = book.mid('binance-perp:BTC')
    const t2 = book.mid('bybit-perp:BTC')
    // T1 tracks (within its half-spread/eps); T2 lags below a rising true mid.
    expect(Math.abs(t1 - trueMid)).toBeLessThan(Math.abs(t2 - trueMid))
    expect(t2).toBeLessThan(trueMid) // stale-cheap on the way up
  })
})

describe('venues — DEX AMM exact slippage (x·y=k)', () => {
  it('buy VWAP equals the closed-form constant-product price with fee', () => {
    const { price, book } = market()
    const M = price.mid('BTC')
    const poolBase = 800_000 / 65_000 // from config: poolNotional / refPrice
    const dx = 0.5
    const r = book.executeMarketable({ venueId: 'uni-amm:BTC', side: 'buy', size: dx })
    const expectedVwap = ((poolBase * M * dx) / (poolBase - dx) / dx) * (1 + 30 / 1e4)
    expect(r.vwap).toBeCloseTo(expectedVwap, 4)
    expect(r.slippagePerUnit).toBeGreaterThan(0)
  })

  it('bigger clips slip more, and slippage is fully deterministic', () => {
    const { book } = market()
    const small = book.executeMarketable({ venueId: 'uni-amm:BTC', side: 'buy', size: 0.2 })
    const big = book.executeMarketable({ venueId: 'uni-amm:BTC', side: 'buy', size: 3 })
    expect(big.slippagePerUnit).toBeGreaterThan(small.slippagePerUnit)
    const repeat = market().book.executeMarketable({ venueId: 'uni-amm:BTC', side: 'buy', size: 3 })
    expect(repeat.vwap).toBe(big.vwap) // deterministic
  })
})

describe('venues — toxicity reaction through a perp venue', () => {
  it('sustained one-sided hedging widens the venue spread, which then heals', () => {
    const { book } = market({ seed: 5 })
    const base = book.getBookSnapshot('bybit-perp:BTC').spread
    // lean hard on the ask side for several ticks
    for (let n = 1; n <= 6; n++) {
      book.executeMarketable({ venueId: 'bybit-perp:BTC', side: 'buy', size: 2 })
      book.tick(n)
    }
    const widened = book.getBookSnapshot('bybit-perp:BTC').spread
    expect(widened).toBeGreaterThan(base)
    // stop trading and let it heal
    for (let n = 7; n <= 400; n++) book.tick(n)
    expect(book.getBookSnapshot('bybit-perp:BTC').spread).toBeCloseTo(base, 2)
  })
})
