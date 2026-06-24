// test/price.test.js — M2 hidden true-mid process.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createPriceProcess, REGIMES } from '../engine/price.js'

const DT = 0.25

function run(assets, ticks, { seed = 1, injectedFn = null } = {}) {
  const rng = createRng(seed)
  const p = createPriceProcess({ rng, dt: DT, assets })
  const mids = Object.fromEntries(assets.map((a) => [a.id, [p.mid(a.id)]]))
  const comps = Object.fromEntries(assets.map((a) => [a.id, []]))
  for (let n = 0; n < ticks; n++) {
    p.step(n, injectedFn ? injectedFn(n) : null)
    for (const a of assets) {
      mids[a.id].push(p.mid(a.id))
      comps[a.id].push(p.components(a.id))
    }
  }
  return { p, mids, comps }
}

// log returns from a mid series
function logReturns(series) {
  const r = []
  for (let i = 1; i < series.length; i++) r.push(Math.log(series[i] / series[i - 1]))
  return r
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const std = (xs) => {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

describe('price — determinism', () => {
  it('same seed/config ⇒ identical mid path', () => {
    const assets = [{ id: 'BTC', m0: 65000, sigma: 0.0008 }]
    const a = run(assets, 500, { seed: 7 })
    const b = run(assets, 500, { seed: 7 })
    expect(a.mids.BTC).toEqual(b.mids.BTC)
  })

  it('different seed ⇒ different path', () => {
    const assets = [{ id: 'BTC', m0: 65000, sigma: 0.0008 }]
    const a = run(assets, 500, { seed: 1 })
    const b = run(assets, 500, { seed: 2 })
    expect(a.mids.BTC).not.toEqual(b.mids.BTC)
  })
})

describe('price — realized vol ≈ σ_M', () => {
  it('per-tick log-return stdev matches configured sigma (flat, no jumps)', () => {
    const sigma = 0.0008
    const assets = [{ id: 'BTC', m0: 65000, sigma, regime: REGIMES.flat }]
    const { mids } = run(assets, 40000, { seed: 42 })
    const realized = std(logReturns(mids.BTC))
    expect(realized).toBeCloseTo(sigma, 4) // within ~1e-4
  })

  it('sigmaM is the price-unit stdev = mid · sigma', () => {
    const sigma = 0.0008
    const assets = [{ id: 'BTC', m0: 65000, sigma }]
    const rng = createRng(3)
    const p = createPriceProcess({ rng, dt: DT, assets })
    expect(p.sigmaM('BTC')).toBeCloseTo(65000 * sigma, 6)
  })
})

describe('price — regime wiring', () => {
  it('up regime drifts up, down drifts down, flat ≈ 0', () => {
    const base = { m0: 1000, sigma: 0.0005, driftMag: 0.0002 }
    const up = run([{ id: 'A', regime: REGIMES.up, ...base }], 20000, { seed: 11 })
    const down = run([{ id: 'A', regime: REGIMES.down, ...base }], 20000, { seed: 11 })
    const flat = run([{ id: 'A', regime: REGIMES.flat, ...base }], 20000, { seed: 11 })
    expect(mean(logReturns(up.mids.A))).toBeGreaterThan(0.00015)
    expect(mean(logReturns(down.mids.A))).toBeLessThan(-0.00015)
    expect(Math.abs(mean(logReturns(flat.mids.A)))).toBeLessThan(0.00005)
  })

  it('mean-revert pulls an off-anchor mid back toward the anchor', () => {
    // Start above anchor; mean of drift should be negative (pulling down).
    const assets = [
      {
        id: 'A',
        m0: 1200,
        anchor: 1000,
        sigma: 0.0003,
        regime: REGIMES.meanRevert,
        meanRevertKappa: 0.02,
      },
    ]
    const { mids } = run(assets, 30000, { seed: 5 })
    const start = mids.A[0]
    const end = mids.A[mids.A.length - 1]
    expect(end).toBeLessThan(start) // drifted back down toward 1000
    expect(end).toBeGreaterThan(950) // and didn't overshoot wildly
  })
})

describe('price — jump wiring', () => {
  it('jumps fire at ≈ λ·dt and fatten the tails', () => {
    const assets = [
      { id: 'A', m0: 1000, sigma: 0.0003, jumpIntensity: 0.4, jumpSigma: 0.02 },
    ]
    const { comps } = run(assets, 40000, { seed: 9 })
    const jumpCount = comps.A.filter((c) => c.jumped).length
    const expected = 0.4 * DT * 40000 // λ·dt·N
    // Poisson count within a loose band of the expectation.
    expect(jumpCount).toBeGreaterThan(expected * 0.8)
    expect(jumpCount).toBeLessThan(expected * 1.2)
  })

  it('no jumps configured ⇒ never jumps', () => {
    const assets = [{ id: 'A', m0: 1000, sigma: 0.0005 }]
    const { comps } = run(assets, 5000, { seed: 1 })
    expect(comps.A.some((c) => c.jumped)).toBe(false)
  })
})

describe('price — toxic-drift attribution (Q3 hook)', () => {
  it('injected r_tox moves the mid and is tracked separately from r_GBM', () => {
    const assets = [{ id: 'A', m0: 1000, sigma: 0.0, regime: REGIMES.flat }] // no diffusion
    const injectedFn = (n) => (n === 3 ? { A: -0.01 } : null)
    const { mids, comps } = run(assets, 6, { seed: 1, injectedFn })
    // With sigma 0 and flat drift, mid only moves on the injected tick.
    expect(comps.A[3].rTox).toBeCloseTo(-0.01, 12)
    expect(comps.A[3].rGBM).toBeCloseTo(0, 12)
    expect(mids.A[4]).toBeLessThan(mids.A[3]) // mid dropped on the toxic tick
    expect(mids.A[1]).toBeCloseTo(mids.A[0], 9) // flat elsewhere
  })
})
