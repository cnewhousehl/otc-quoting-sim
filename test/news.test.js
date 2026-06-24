// test/news.test.js — news catalysts pivot the true mid by signed magnitude.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createNewsEngine, mergeInjections } from '../engine/news.js'
import { runFromSeed } from '../engine/session.js'

const DT = 0.25
const ASSETS = ['BTC', 'ETH', 'SOL', 'WIF']

describe('news engine', () => {
  it('fires on the configured cadence (±jitter)', () => {
    const news = createNewsEngine({ rng: createRng(1), dt: DT, assetIds: ASSETS, intervalMin: 3 })
    const fires = []
    for (let n = 0; n < 15 * 60 * 4; n++) {
      // 15 min @ 4 ticks/s
      const ev = news.step(n)
      if (ev) fires.push(n)
    }
    expect(fires.length).toBeGreaterThanOrEqual(3)
    const gapSec = (fires[1] - fires[0]) * DT
    expect(gapSec).toBeGreaterThan(3 * 60 * 0.7) // ~3 min ±20%
    expect(gapSec).toBeLessThan(3 * 60 * 1.3)
  })

  it('a fired catalyst injects a smooth drift summing to its signed total return', () => {
    const news = createNewsEngine({ rng: createRng(2), dt: DT, assetIds: ASSETS, intervalMin: 1 })
    let ev = null
    let fireTick = 0
    for (let n = 0; n < 1000 && !ev; n++) {
      const e = news.step(n)
      if (e) {
        ev = e
        fireTick = n
      }
    }
    expect(ev).toBeTruthy()
    // sum the per-tick injection on an affected asset over the horizon
    const asset = ev.assets[0]
    let total = 0
    for (let n = fireTick; n <= fireTick + ev.horizonTicks + 2; n++) {
      total += news.injectionAt(n)[asset] ?? 0
    }
    expect(total).toBeCloseTo(ev.totalReturn, 6)
    expect(Math.sign(total)).toBe(ev.direction)
  })

  it('macro news hits all assets; asset-specific news only its assets', () => {
    // Check the FIRST fire of each engine (no overlap from prior catalysts).
    let sawMacro = false
    let sawAsset = false
    for (const seed of [5, 7, 13, 21, 30, 44]) {
      const news = createNewsEngine({ rng: createRng(seed), dt: DT, assetIds: ASSETS, intervalMin: 1 })
      let ev = null
      let ft = 0
      for (let n = 0; n < 1000 && !ev; n++) {
        const e = news.step(n)
        if (e) { ev = e; ft = n }
      }
      const inj = news.injectionAt(ft + 1)
      const hit = Object.keys(inj).filter((k) => Math.abs(inj[k]) > 0).sort()
      const expected = (ev.scope === 'macro' ? [...ASSETS] : ev.assets).slice().sort()
      expect(hit).toEqual(expected)
      if (ev.scope === 'macro') sawMacro = true
      else sawAsset = true
    }
    expect(sawMacro && sawAsset).toBe(true) // covered both kinds
  })

  it('mergeInjections sums toxic + news per asset', () => {
    expect(mergeInjections({ BTC: 0.01 }, { BTC: -0.004, ETH: 0.002 })).toEqual({ BTC: 0.006, ETH: 0.002 })
  })
})

describe('news in a session', () => {
  it('emits news events and exposes the next-news countdown', () => {
    const { eventLog, finalState } = runFromSeed(11, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 10, newsIntervalMin: 2 } })
    const newsEvents = eventLog.filter((e) => e.type === 'news')
    expect(newsEvents.length).toBeGreaterThan(0)
    expect(newsEvents[0]).toHaveProperty('headline')
    expect(finalState.nextNewsSec).toBeGreaterThanOrEqual(0)
  })
})
