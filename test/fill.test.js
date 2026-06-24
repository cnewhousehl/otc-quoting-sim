// test/fill.test.js — M5 quote lifecycle + soft-client fill hazard.
//
// Note: these assert the MODEL's qualitative shape (mid-market fills, decreasing
// S-curve in width). The exact Q7 fill-rate bands per difficulty are calibrated
// against the real Q6 coefficients in M10; the soft params here are representative.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createQuoteBook, QUOTE_STATE } from '../engine/quote.js'
import { evaluateQuoteFill, softG } from '../engine/fill.js'

const DT = 0.25
const TTL = 120
const MID = 65000
const SIGMA_M = 30 // price-unit per-tick stdev

const SOFT_CLIENT = {
  archetype: 'soft',
  // Symmetric two-way exposes both sides as independent hazards (client can lift
  // OR hit), so the effective contact rate is ~2× a single side — λ is set so the
  // tight end isn't saturated and the width S-curve spans a meaningful range.
  lambda: 0.03,
  eta: 0.3,
  xRef: 5,
  tauReact: 2,
  soft: { s0: 0.5, s1: 3.0, omega: 1.0, b: 0.8 },
}
const DIFF = { dDiff: 1 }

// Empirical fill rate over N independent quotes at a given symmetric width (in σ).
function fillRate(widthSigma, { N = 3000, seed = 123, size = 5, client = SOFT_CLIENT } = {}) {
  const rng = createRng(seed)
  const qb = createQuoteBook({ ttlTicks: TTL })
  let filled = 0
  for (let i = 0; i < N; i++) {
    const w = widthSigma * SIGMA_M
    const q = qb.submit({
      rfqId: `r${i}`,
      assetId: 'BTC',
      clientId: 'soft-1',
      archetype: client.archetype,
      bid: MID - w,
      ask: MID + w,
      size,
      tick: 0,
    })
    for (let n = 1; n <= TTL; n++) {
      const res = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n, dt: DT, rng, client, diff: DIFF })
      if (res) {
        filled++
        break
      }
    }
  }
  return filled / N
}

describe('quote — lifecycle', () => {
  it('submit creates a live quote with a TTL', () => {
    const qb = createQuoteBook({ ttlTicks: TTL })
    const q = qb.submit({ rfqId: 'r1', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    expect(q.state).toBe(QUOTE_STATE.live)
    expect(qb.live()).toHaveLength(1)
  })

  it('cancel ("off") removes it from live', () => {
    const qb = createQuoteBook()
    const q = qb.submit({ rfqId: 'r1', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    qb.cancel(q.id, 3)
    expect(qb.get(q.id).state).toBe(QUOTE_STATE.cancelled)
    expect(qb.live()).toHaveLength(0)
  })

  it('refresh re-prices and resets the age clock', () => {
    const qb = createQuoteBook()
    const q = qb.submit({ rfqId: 'r1', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    qb.refresh(q.id, { bid: 1.5, ask: 2.5 }, 40)
    expect(q.bid).toBe(1.5)
    expect(q.createdTick).toBe(40)
    expect(q.refreshCount).toBe(1)
    expect(q.state).toBe(QUOTE_STATE.live)
  })

  it('expireDue closes quotes past TTL', () => {
    const qb = createQuoteBook({ ttlTicks: TTL })
    qb.submit({ rfqId: 'r1', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: 1, ask: 2, size: 5, tick: 0 })
    expect(qb.expireDue(TTL - 1)).toHaveLength(0)
    expect(qb.expireDue(TTL)).toHaveLength(1)
    expect(qb.live()).toHaveLength(0)
  })
})

describe('fill — soft archetype hazard', () => {
  it('no fill on the creation tick (decision latency)', () => {
    const rng = createRng(1)
    const qb = createQuoteBook()
    const q = qb.submit({ rfqId: 'r', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: MID - 5, ask: MID + 5, size: 5, tick: 0 })
    expect(evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 0, dt: DT, rng, client: SOFT_CLIENT, diff: DIFF })).toBeNull()
  })

  it('is deterministic for identical coordinates', () => {
    const qb = createQuoteBook()
    const q = qb.submit({ rfqId: 'r', assetId: 'BTC', clientId: 'c', archetype: 'soft', bid: MID - 5, ask: MID + 5, size: 5, tick: 0 })
    const a = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 30, dt: DT, rng: createRng(7), client: SOFT_CLIENT, diff: DIFF })
    const b = evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n: 30, dt: DT, rng: createRng(7), client: SOFT_CLIENT, diff: DIFF })
    expect(a).toEqual(b)
  })

  it('softG is monotone increasing in edge', () => {
    const p = SOFT_CLIENT.soft
    expect(softG(-2, p)).toBeLessThan(softG(0, p))
    expect(softG(0, p)).toBeLessThan(softG(2, p))
  })

  it('mid-market soft quote fills ≥ 0.97 within TTL', () => {
    expect(fillRate(0.25)).toBeGreaterThanOrEqual(0.97)
  })

  it('win-rate is a decreasing S-curve in width', () => {
    const r = [0.25, 1, 2, 3].map((w) => fillRate(w))
    for (let i = 1; i < r.length; i++) {
      expect(r[i]).toBeLessThan(r[i - 1])
    }
    // and it spans a meaningful range (not saturated flat)
    expect(r[0] - r[r.length - 1]).toBeGreaterThan(0.1)
  })

  it('bigger clips are harder to fill (size penalty L(X))', () => {
    const small = fillRate(1, { size: 3 })
    const big = fillRate(1, { size: 40 })
    expect(big).toBeLessThan(small)
  })
})
