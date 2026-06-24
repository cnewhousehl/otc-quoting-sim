// test/rfq.test.js — M8 RFQ arrivals, weighting, sizing, cap.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createRfqGenerator } from '../engine/rfq.js'
import { getDifficulty } from '../config/difficulty.js'
import { ROSTER } from '../config/clients.js'
import { ASSET_UNIVERSE, assetLiquidityNotional } from '../config/venues.js'

const DT = 0.25

function gen(level = 'medium', seed = 1) {
  return createRfqGenerator({
    rng: createRng(seed),
    dt: DT,
    difficulty: getDifficulty(level),
    universe: ASSET_UNIVERSE,
    roster: ROSTER,
    liquidityNotional: assetLiquidityNotional,
  })
}

// drive N ticks with the pending cap never binding; collect arrivals
function collect(generator, N) {
  const out = []
  for (let n = 0; n < N; n++) {
    const r = generator.step(n, 0)
    if (r) out.push(r)
  }
  return out
}

describe('rfq — arrivals', () => {
  it('arrival rate ≈ λ·dt per tick', () => {
    const d = getDifficulty('medium')
    const arrivals = collect(gen('medium', 11), 20000)
    const rate = arrivals.length / 20000
    expect(rate).toBeCloseTo(d.arrivalRate * DT, 1) // 0.8·0.25 = 0.2
  })

  it('is deterministic for a given seed', () => {
    const a = collect(gen('medium', 5), 500).map((r) => `${r.id}:${r.assetId}:${r.clientId}`)
    const b = collect(gen('medium', 5), 500).map((r) => `${r.id}:${r.assetId}:${r.clientId}`)
    expect(a).toEqual(b)
  })
})

describe('rfq — pending cap', () => {
  it('suppresses arrivals when the cap is hit', () => {
    const g = gen('medium')
    const d = getDifficulty('medium')
    let made = 0
    for (let n = 0; n < 5000; n++) if (g.step(n, d.maxPendingRFQs)) made++
    expect(made).toBe(0)
  })

  it('allows arrivals below the cap', () => {
    const g = gen('medium')
    let made = 0
    for (let n = 0; n < 5000; n++) if (g.step(n, 0)) made++
    expect(made).toBeGreaterThan(0)
  })
})

describe('rfq — asset weighting & sizing', () => {
  it('majors arrive far more often than esoteric DEX-only names', () => {
    const arrivals = collect(gen('medium', 7), 20000)
    const counts = {}
    for (const r of arrivals) counts[r.assetId] = (counts[r.assetId] ?? 0) + 1
    expect(counts.BTC).toBeGreaterThan(counts.WIF)
  })

  it('clip notional scales with asset liquidity (BTC clips ≫ WIF clips)', () => {
    const arrivals = collect(gen('medium', 9), 40000)
    const median = (xs) => {
      const s = xs.slice().sort((a, b) => a - b)
      return s[Math.floor(s.length / 2)]
    }
    const btc = median(arrivals.filter((r) => r.assetId === 'BTC').map((r) => r.notional))
    const wif = median(arrivals.filter((r) => r.assetId === 'WIF').map((r) => r.notional))
    expect(btc).toBeGreaterThan(wif)
    expect(arrivals.every((r) => r.size > 0)).toBe(true)
  })
})

describe('rfq — toxic share scales with difficulty', () => {
  it('Hard flow is more toxic than Easy flow', () => {
    const toxShare = (level) => {
      const a = collect(gen(level, 3), 20000)
      return a.filter((r) => r.isToxic).length / a.length
    }
    const easy = toxShare('easy')
    const hard = toxShare('hard')
    expect(hard).toBeGreaterThan(easy + 0.2)
    expect(easy).toBeGreaterThan(0) // some ambiguous toxic flow even on easy
  })
})
