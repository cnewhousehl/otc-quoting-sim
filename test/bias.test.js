// test/bias.test.js — client directional bias + news sentiment.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createQuoteBook } from '../engine/quote.js'
import { evaluateQuoteFill } from '../engine/fill.js'
import { resolveClient } from '../engine/client.js'
import { getDifficulty } from '../config/difficulty.js'
import { runFromSeed } from '../engine/session.js'

const DT = 0.25
const MID = 65000
const SIGMA_M = MID * 0.00005

// Fraction of fills that hit the ASK (client lifts/buys) for a given bias, at a
// moderately-wide symmetric width (so the bias-driven side asymmetry shows).
function liftRate(bias, { N = 3000, bps = 40, seed = 7 } = {}) {
  const d = getDifficulty('medium')
  const client = resolveClient({ id: 'c', archetype: 'soft' }, d)
  client.hedgeWidth = MID * 0.0015
  client.bias = bias
  const rng = createRng(seed)
  const qb = createQuoteBook({ ttlTicks: 180 })
  let lifts = 0
  let fills = 0
  for (let i = 0; i < N; i++) {
    const w = (MID * bps) / 1e4
    const q = qb.submit({ rfqId: `r${i}`, assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: MID - w, ask: MID + w, size: 5, tick: 0 })
    for (let n = 1; n <= 180; n++) {
      const res = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n, dt: DT, rng, client, diff: { dDiff: d.hazardScale } })
      if (res) {
        fills++
        if (res.side === 'ask') lifts++
        break
      }
    }
  }
  return lifts / fills
}

describe('client bias — willingness to cross', () => {
  it('bullish clients lift (buy the ask) far more than bearish clients', () => {
    const bull = liftRate(0.8)
    const bear = liftRate(-0.8)
    expect(bull).toBeGreaterThan(0.7)
    expect(bear).toBeLessThan(0.3)
  })

  it('neutral bias is roughly balanced', () => {
    const neutral = liftRate(0)
    expect(neutral).toBeGreaterThan(0.35)
    expect(neutral).toBeLessThan(0.65)
  })
})

describe('news sentiment → client bias (in session)', () => {
  it('bias is revealed on Easy and hidden on Hard', () => {
    const easy = runFromSeed(4, { difficulty: 'easy', tier: 'pro', config: { sessionMinutes: 6, newsIntervalMin: 1 } }).eventLog
    const hard = runFromSeed(4, { difficulty: 'hard', tier: 'pro', config: { sessionMinutes: 6, newsIntervalMin: 1 } }).eventLog
    const easyRfqs = easy.filter((e) => e.type === 'rfq_new')
    const hardRfqs = hard.filter((e) => e.type === 'rfq_new')
    expect(easyRfqs.some((e) => e.bias === 'bullish' || e.bias === 'bearish')).toBe(true)
    expect(hardRfqs.every((e) => e.bias == null)).toBe(true)
  })

  it('positive catalysts tilt subsequent flow on the affected assets bullish', () => {
    const { eventLog } = runFromSeed(2, { difficulty: 'easy', tier: 'pro', config: { sessionMinutes: 20, newsIntervalMin: 2 } })
    const ups = eventLog.filter((e) => e.type === 'news' && e.direction > 0)
    expect(ups.length).toBeGreaterThan(0)
    let bull = 0
    let bear = 0
    for (const up of ups) {
      const after = eventLog.filter(
        (e) => e.type === 'rfq_new' && e.tick > up.tick && e.tick < up.tick + 240 && up.assets.includes(e.assetId),
      )
      bull += after.filter((e) => e.bias === 'bullish').length
      bear += after.filter((e) => e.bias === 'bearish').length
    }
    expect(bull).toBeGreaterThanOrEqual(bear) // aggregate flow tilts bullish post-positive-news
  })
})
