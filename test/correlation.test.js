// test/correlation.test.js — alts co-move with the market factor.
import { describe, it, expect } from 'vitest'
import { createRng } from '../engine/rng.js'
import { createPriceProcess } from '../engine/price.js'

const DT = 0.25

function returns(series) {
  const r = []
  for (let i = 1; i < series.length; i++) r.push(Math.log(series[i] / series[i - 1]))
  return r
}
function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / a.length
  const mb = b.reduce((x, y) => x + y, 0) / b.length
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb)
    va += (a[i] - ma) ** 2
    vb += (b[i] - mb) ** 2
  }
  return cov / Math.sqrt(va * vb)
}

function run(assets, ticks, seed = 1) {
  const rng = createRng(seed)
  const p = createPriceProcess({ rng, dt: DT, assets })
  const series = Object.fromEntries(assets.map((a) => [a.id, [p.mid(a.id)]]))
  for (let n = 0; n < ticks; n++) {
    p.step(n)
    for (const a of assets) series[a.id].push(p.mid(a.id))
  }
  return series
}

describe('cross-asset correlation', () => {
  it('correlated assets co-move; their return correlation is high', () => {
    const assets = [
      { id: 'BTC', m0: 65000, sigma: 0.00005, corr: 0.9 },
      { id: 'SOL', m0: 150, sigma: 0.00009, corr: 0.92 },
    ]
    const s = run(assets, 20000)
    const c = corr(returns(s.BTC), returns(s.SOL))
    expect(c).toBeGreaterThan(0.7) // ≈ 0.9·0.92
  })

  it('corr=0 assets are ~uncorrelated', () => {
    const assets = [
      { id: 'A', m0: 100, sigma: 0.0005, corr: 0 },
      { id: 'B', m0: 100, sigma: 0.0005, corr: 0 },
    ]
    const s = run(assets, 20000)
    expect(Math.abs(corr(returns(s.A), returns(s.B)))).toBeLessThan(0.1)
  })

  it('per-asset realized vol is preserved regardless of correlation', () => {
    const assets = [{ id: 'BTC', m0: 65000, sigma: 0.00005, corr: 0.9 }]
    const s = run(assets, 40000)
    const r = returns(s.BTC)
    const m = r.reduce((a, b) => a + b, 0) / r.length
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length)
    expect(sd).toBeCloseTo(0.00005, 5)
  })
})
