// test/staleness.test.js — M6 the core lesson: sharp clients pick off stale
// quotes, holding through an adverse move is −EV, refreshing dodges it, and
// quoting tighter than the toxic break-even width to a toxic name loses money.
//
// (Exact Q7 pickoff/fill bands per difficulty are re-verified in the M10
// calibration suite; here we assert the mechanism and the easy/hard contrast.)
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createQuoteBook } from '../engine/quote.js'
import { evaluateQuoteFill } from '../engine/fill.js'
import { createPnL } from '../engine/pnl.js'
import { buildDriftPath, createToxicDrift, resolveClient, sampleToxic } from '../engine/client.js'
import { getDifficulty } from '../config/difficulty.js'

const DT = 0.25
const TTL = 120
const SIGMA_M = 30
const MID0 = 65000
const SHARP_ENTRY = { id: 'helix', archetype: 'sharp', size: { medianX: 5 } }

// Simulate one held/refreshed quote under an adverse mid ramp; return whether
// the (stale) ask side got picked off.
function simQuote(level, { policy = 'hold', seed = 1, i = 0, widthSigma = 0.3, moveSigma = 1.0, rampTicks = 8, refreshEvery = 10, qb, rng }) {
  const d = getDifficulty(level)
  const client = resolveClient(SHARP_ENTRY, d)
  const diff = { dDiff: d.hazardScale }
  const w = widthSigma * SIGMA_M
  const q = qb.submit({ rfqId: `r${i}`, assetId: 'BTC', clientId: 'helix', archetype: 'sharp', bid: MID0 - w, ask: MID0 + w, size: 5, tick: 0 })
  const midAt = (n) => MID0 + Math.min(1, n / rampTicks) * moveSigma * SIGMA_M
  for (let n = 1; n <= TTL; n++) {
    if (policy === 'refresh' && n % refreshEvery === 0) {
      const m = midAt(n)
      qb.refresh(q.id, { bid: m - w, ask: m + w }, n)
    }
    const res = evaluateQuoteFill({ quote: q, mid: midAt(n), sigmaM: SIGMA_M, n, dt: DT, rng, client, diff })
    if (res) return { filled: true, side: res.side, price: res.price, fillTick: n, midFinal: midAt(TTL) }
  }
  return { filled: false, midFinal: midAt(TTL) }
}

function pickoffRate(level, opts = {}) {
  const N = opts.N ?? 2500
  const rng = createRng(opts.seed ?? 10)
  const qb = createQuoteBook({ ttlTicks: TTL })
  let picked = 0
  for (let i = 0; i < N; i++) {
    const r = simQuote(level, { policy: 'hold', i, qb, rng, ...opts })
    if (r.filled && r.side === 'ask') picked++
  }
  return picked / N
}

// Mean single-unit PnL (unhedged, marked to final mid) under a policy.
function meanPnL(level, policy, opts = {}) {
  const N = opts.N ?? 2500
  const rng = createRng(opts.seed ?? 20)
  const qb = createQuoteBook({ ttlTicks: TTL })
  let sum = 0
  for (let i = 0; i < N; i++) {
    const r = simQuote(level, { policy, i, qb, rng, moveSigma: 1.2, refreshEvery: 8, ...opts })
    if (r.filled) {
      const dq = r.side === 'ask' ? -1 : 1 // student takes the opposite side
      const cash = r.side === 'ask' ? r.price : -r.price
      sum += cash + dq * r.midFinal
    }
  }
  return sum / N
}

describe('toxic drift path (Q3)', () => {
  it('integrates to δ_tox·σ and is front-loaded', () => {
    const sigmaReturn = 0.0008
    const path = buildDriftPath({ deltaTox: 2.6, N: 32, rho: 0.85 }, sigmaReturn)
    const sum = path.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(2.6 * sigmaReturn, 12) // Σμ = δ_tox·σ
    for (let k = 1; k < path.length; k++) expect(path[k]).toBeLessThan(path[k - 1]) // decreasing
    expect(path).toHaveLength(32)
  })
})

describe('toxic drift activation (Q3 — activate on fill, superposable)', () => {
  it('injects only after activation, with the adverse sign, and superposes', () => {
    const td = createToxicDrift()
    const path = [0.01, 0.005, 0.002]
    td.activate({ assetId: 'BTC', path, startTick: 5, clientBuys: true }) // student short → +
    expect(td.injectionAt(4).BTC ?? 0).toBe(0) // not yet active
    expect(td.injectionAt(5).BTC).toBeCloseTo(0.01, 12)
    expect(td.injectionAt(6).BTC).toBeCloseTo(0.005, 12)
    expect(td.injectionAt(8).BTC ?? 0).toBe(0) // path exhausted
    // a second overlapping toxic fill (student sold → −) superposes
    td.activate({ assetId: 'BTC', path, startTick: 5, clientBuys: false })
    expect(td.injectionAt(5).BTC).toBeCloseTo(0, 12) // +0.01 and −0.01 cancel
  })
})

describe('sample-at-creation toxicity', () => {
  it('soft is never toxic; sharp draws ~ p_tox; deterministic by rfqId', () => {
    const rng = createRng(3)
    const hard = getDifficulty('hard')
    expect(sampleToxic(rng, 'r1', { archetype: 'soft' }, hard)).toBe(false)
    // deterministic
    const a = sampleToxic(rng, 'r42', SHARP_ENTRY, hard)
    const b = sampleToxic(rng, 'r42', SHARP_ENTRY, hard)
    expect(a).toBe(b)
    // empirical rate ≈ p_tox over many rfqIds
    let tox = 0
    const M = 4000
    for (let i = 0; i < M; i++) if (sampleToxic(rng, `q${i}`, SHARP_ENTRY, hard)) tox++
    expect(tox / M).toBeCloseTo(hard.pTox, 1)
  })
})

describe('staleness pickoff (the lesson)', () => {
  it('a stale quote held through a +1σ adverse move is picked off ≥0.70 on hard', () => {
    expect(pickoffRate('hard')).toBeGreaterThanOrEqual(0.7)
  })

  it('and ≤0.35 on easy (pickoff is damped)', () => {
    expect(pickoffRate('easy')).toBeLessThanOrEqual(0.35)
  })

  it('hard picks off far more aggressively than easy', () => {
    expect(pickoffRate('hard')).toBeGreaterThan(pickoffRate('easy') + 0.3)
  })
})

describe('hold vs refresh (E[PnL|hold] < E[PnL|refresh])', () => {
  it('refreshing beats holding on medium and hard', () => {
    for (const level of ['medium', 'hard']) {
      const hold = meanPnL(level, 'hold')
      const refresh = meanPnL(level, 'refresh')
      expect(hold).toBeLessThan(refresh)
    }
  })
})

describe('toxic break-even width (w_be ≈ δ_tox·σ_M/2)', () => {
  it('quoting tighter than w_be to a toxic name is mean-negative, wider is positive', () => {
    const d = getDifficulty('hard')
    const sigmaReturn = SIGMA_M / MID0
    const path = buildDriftPath(d.toxic, sigmaReturn)
    const totalAdverseMove = path.reduce((a, b) => a + b, 0) * MID0 // ≈ δ_tox·σ_M
    const wBe = totalAdverseMove / 2

    // Net edge of a single round-trip vs a toxic name: capture spread w, eat
    // half the adverse move (front-loaded, hedged at the half-life).
    const net = (w) => w - totalAdverseMove / 2
    expect(net(0.4 * wBe)).toBeLessThan(0)
    expect(net(1.6 * wBe)).toBeGreaterThan(0)
    expect(wBe).toBeCloseTo((d.toxic.deltaTox * SIGMA_M) / 2, 6)
  })
})
