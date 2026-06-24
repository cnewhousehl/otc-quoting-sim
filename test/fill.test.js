// test/fill.test.js — quote lifecycle + hedge-cost-anchored fill model.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createQuoteBook, QUOTE_STATE } from '../engine/quote.js'
import { evaluateQuoteFill, fillG } from '../engine/fill.js'
import { resolveClient } from '../engine/client.js'
import { getDifficulty } from '../config/difficulty.js'

const DT = 0.25
const TTL = 180
const MID = 65000
const SIGMA_M = MID * 0.00005

// Empirical fill rate at a symmetric width (bps), for an archetype whose clip
// costs `hedgeBps` to hedge.
function fillRate(arch, bps, { hedgeBps = 8, bias = 0, favorBonus = 0, level = 'medium', N = 2000, seed = 5 } = {}) {
  const d = getDifficulty(level)
  const c = resolveClient({ id: 'c', archetype: arch }, d)
  c.hedgeWidth = (MID * hedgeBps) / 1e4
  c.bias = bias
  c.favorBonus = favorBonus
  const rng = createRng(seed)
  const qb = createQuoteBook({ ttlTicks: TTL })
  let f = 0
  for (let i = 0; i < N; i++) {
    const w = (MID * bps) / 1e4
    const q = qb.submit({ rfqId: `r${i}`, assetId: 'B', clientId: 'c', archetype: arch, bid: MID - w, ask: MID + w, size: 5, tick: 0 })
    for (let n = 1; n <= TTL; n++) {
      if (evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n, dt: DT, rng, client: c, diff: { dDiff: d.hazardScale } })) {
        f++
        break
      }
    }
  }
  return f / N
}

describe('quote — lifecycle', () => {
  it('submit → live; cancel → off; refresh resets age; expire past TTL', () => {
    const qb = createQuoteBook({ ttlTicks: TTL })
    const q = qb.submit({ rfqId: 'r1', assetId: 'B', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    expect(q.state).toBe(QUOTE_STATE.live)
    qb.refresh(q.id, { bid: 1.5, ask: 2.5 }, 40)
    expect(q.createdTick).toBe(40)
    qb.cancel(q.id, 41)
    expect(q.state).toBe(QUOTE_STATE.cancelled)
    const q2 = qb.submit({ rfqId: 'r2', assetId: 'B', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    expect(qb.expireDue(TTL).map((x) => x.id)).toContain(q2.id)
  })
})

describe('fill — shape & determinism', () => {
  it('fillG is 1 deep inside reservation (or stale), decays to floor when wide', () => {
    expect(fillG({ w: -50, reservation: 100, slope: 40, floor: 0.05 })).toBeGreaterThan(0.95) // stale ITM
    expect(fillG({ w: 400, reservation: 100, slope: 40, floor: 0.05 })).toBeLessThan(0.1) // very wide
    expect(fillG({ w: 50, reservation: 100, slope: 40, floor: 0.05 })).toBeGreaterThan(fillG({ w: 150, reservation: 100, slope: 40, floor: 0.05 }))
  })

  it('no fill on the creation tick; deterministic for identical coordinates', () => {
    const d = getDifficulty('medium')
    const c = resolveClient({ id: 'c', archetype: 'soft' }, d)
    c.hedgeWidth = MID * 0.0008
    const qb = createQuoteBook()
    const q = qb.submit({ rfqId: 'r', assetId: 'B', clientId: 'c', archetype: 'soft', bid: MID - 5, ask: MID + 5, size: 5, tick: 0 })
    expect(evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 0, dt: DT, rng: createRng(1), client: c, diff: { dDiff: 1 } })).toBeNull()
    const a = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 30, dt: DT, rng: createRng(7), client: c, diff: { dDiff: 1 } })
    const b = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 30, dt: DT, rng: createRng(7), client: c, diff: { dDiff: 1 } })
    expect(a).toEqual(b)
  })
})

describe('fill — hedge-cost anchoring (the lesson)', () => {
  it('tight quotes fill; win-rate decreases with width', () => {
    expect(fillRate('soft', 10)).toBeGreaterThan(0.8)
    expect(fillRate('soft', 10)).toBeGreaterThan(fillRate('soft', 60))
    expect(fillRate('soft', 60)).toBeGreaterThan(fillRate('soft', 200))
  })

  it('sharp counterparties barely pay up — they collapse with width faster than retail', () => {
    expect(fillRate('sharp', 20)).toBeGreaterThan(0.5) // trade near hedgeable + small
    expect(fillRate('sharp', 80)).toBeLessThan(0.15) // never let you fill them wide
    expect(fillRate('sharp', 80)).toBeLessThan(fillRate('soft', 80)) // retail more flexible
  })

  it('a clip that is expensive to hedge lets you quote wider and still win', () => {
    const cheapHedge = fillRate('sharp', 90, { hedgeBps: 8 }) // 90bps quote, liquid → no fill
    const dearHedge = fillRate('sharp', 90, { hedgeBps: 90 }) // 90bps quote, illiquid → wins
    expect(dearHedge).toBeGreaterThan(cheapHedge + 0.4)
  })

  it('relationship favor lets a well-treated client accept a wider quote', () => {
    const neutral = fillRate('mid', 60, { favorBonus: 0 })
    const favored = fillRate('mid', 60, { favorBonus: 0.85 })
    expect(favored).toBeGreaterThan(neutral)
  })
})
