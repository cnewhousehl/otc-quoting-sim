// test/calibration.test.js — M10 the "engine-done" calibration gate.
//
// Consolidated cross-cutting invariants that must hold for the engine to teach
// correctly. Per-module behavior is covered in the other suites; this locks in
// the calibration that spans modules (difficulty monotonicity, the fill curve,
// hedge sweeping, the P&L identity, replay determinism).
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createQuoteBook } from '../engine/quote.js'
import { evaluateQuoteFill } from '../engine/fill.js'
import { resolveClient } from '../engine/client.js'
import { getDifficulty } from '../config/difficulty.js'
import { createSession, runFromSeed } from '../engine/session.js'

const DT = 0.25
const MID = 65000
const SIGMA_M = MID * 0.00005

// ---- fill curve (hedge-cost-anchored) --------------------------------------
function fillRate(arch, bps, { hedgeBps = 8, N = 1500, level = 'medium' } = {}) {
  const d = getDifficulty(level)
  const c = resolveClient({ id: 'c', archetype: arch }, d)
  c.hedgeWidth = (MID * hedgeBps) / 1e4
  c.bias = 0
  c.favorBonus = 0
  const rng = createRng(5)
  const qb = createQuoteBook({ ttlTicks: 180 })
  let f = 0
  for (let i = 0; i < N; i++) {
    const w = (MID * bps) / 1e4
    const q = qb.submit({ rfqId: `r${i}`, assetId: 'B', clientId: 'c', archetype: arch, bid: MID - w, ask: MID + w, size: 5, tick: 0 })
    for (let n = 1; n <= 180; n++) {
      if (evaluateQuoteFill({ quote: q, mid: MID, sigmaM: SIGMA_M, n, dt: DT, rng, client: c, diff: { dDiff: d.hazardScale } })) {
        f++
        break
      }
    }
  }
  return f / N
}

describe('M10 — fill calibration', () => {
  it('tight quotes win; width is a decreasing S-curve', () => {
    expect(fillRate('soft', 8)).toBeGreaterThan(0.8)
    expect(fillRate('soft', 8)).toBeGreaterThan(fillRate('soft', 60))
    expect(fillRate('soft', 60)).toBeGreaterThan(fillRate('soft', 200))
  })

  it('sharp/sophisticated flow barely pays up vs retail', () => {
    expect(fillRate('sharp', 20)).toBeGreaterThan(0.4) // trades near hedgeable + small
    expect(fillRate('sharp', 80)).toBeLessThan(fillRate('soft', 80) - 0.2) // collapses faster than retail
  })

  it('an illiquid (dear-to-hedge) clip can win a much wider quote', () => {
    expect(fillRate('sharp', 90, { hedgeBps: 90 })).toBeGreaterThan(fillRate('sharp', 90, { hedgeBps: 8 }) + 0.4)
  })
})

// ---- hedge book always sweeps to fill --------------------------------------
describe('M10 — hedge sweeps to fill', () => {
  it('a marketable hedge always fills the full size; bigger clips cost more', () => {
    const s = createSession({ seed: 4, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 5 } })
    for (let i = 0; i < 6; i++) s.tick()
    const v = s.venuesForAsset('BTC')[0]
    const mid = s.getBookSnapshot(v).mid
    const small = s.hedge({ assetId: 'BTC', venueId: v, side: 'buy', size: 2e6 / mid })
    expect(small.partial).toBe(false)
    const s2 = createSession({ seed: 4, difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 5 } })
    for (let i = 0; i < 6; i++) s2.tick()
    const big = s2.hedge({ assetId: 'BTC', venueId: v, side: 'buy', size: 12e6 / mid })
    expect(big.partial).toBe(false)
    expect(big.filledSize).toBeCloseTo(12e6 / mid, 2)
    expect(big.slippagePerUnit).toBeGreaterThan(small.slippagePerUnit) // sweeping deeper costs more
  })
})

// ---- difficulty monotonicity (the gate) ------------------------------------
describe('M10 — difficulty monotonicity', () => {
  // fixed mediocre policy: quote a fixed width, warehouse (never hedge)
  const policy = (state, s) =>
    state.pendingRfqs.map((r) => {
      const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
      const w = (mid * 10) / 1e4
      return { type: 'submitQuote', rfqId: r.id, bid: mid - w, ask: mid + w }
    })

  const toxShare = (level) => {
    let tox = 0
    let rf = 0
    for (const seed of [1, 2]) {
      const { eventLog } = runFromSeed(seed, { difficulty: level, tier: 'pro', config: { sessionMinutes: 4 } }, policy)
      const rfqs = eventLog.filter((e) => e.type === 'rfq_new')
      tox += rfqs.filter((e) => e.isToxic).length
      rf += rfqs.length
    }
    return tox / rf
  }

  it('toxic/informed flow share strictly increases easy → medium → hard', { timeout: 30000 }, () => {
    const e = toxShare('easy')
    const m = toxShare('medium')
    const h = toxShare('hard')
    expect(m).toBeGreaterThan(e) // ≈ p_tox per level, deterministic
    expect(h).toBeGreaterThan(m)
    expect(h).toBeGreaterThan(0.7) // Hard flow is dominated by informed names
  })
})

// ---- accounting + replay (the grading substrate) ---------------------------
describe('M10 — accounting & replay', () => {
  const scripted = (state, s) =>
    state.pendingRfqs.map((r) => {
      const mid = s.getBookSnapshot(s.venuesForAsset(r.assetId)[0]).mid
      const w = mid * 0.0006
      return { type: 'submitQuote', rfqId: r.id, bid: mid - w, ask: mid + w }
    })

  it('P&L decomposition reconciles to total over a full run', () => {
    const { finalState } = runFromSeed(7, { difficulty: 'medium', tier: 'pro', config: { sessionMinutes: 6 } }, scripted)
    const d = finalState.decomposition
    expect(d.grossSpread + d.invMtM + d.advSel - d.hedgeSlippage - d.fees).toBeCloseTo(finalState.totalPnL, 5)
  })

  it('same seed + policy ⇒ byte-identical event log (the grading property)', () => {
    const a = runFromSeed(11, { difficulty: 'hard', tier: 'pro', config: { sessionMinutes: 5 } }, scripted)
    const b = runFromSeed(11, { difficulty: 'hard', tier: 'pro', config: { sessionMinutes: 5 } }, scripted)
    expect(JSON.stringify(a.eventLog)).toBe(JSON.stringify(b.eventLog))
  })
})
