// test/rng.test.js — M1 determinism + stream-isolation gate.
import { describe, it, expect } from 'vitest'
import { createRng, inverseNormalCDF, STREAMS } from '../engine/rng.js'

describe('rng — determinism', () => {
  it('same coordinates ⇒ identical value', () => {
    const a = createRng(42)
    const b = createRng(42)
    for (let n = 0; n < 50; n++) {
      expect(a.uniform(STREAMS.price, n, 'BTC')).toBe(b.uniform(STREAMS.price, n, 'BTC'))
      expect(a.normal(STREAMS.execHazard, n, 'q7', 2)).toBe(
        b.normal(STREAMS.execHazard, n, 'q7', 2),
      )
    }
  })

  it('different seed ⇒ different value', () => {
    const a = createRng(1)
    const b = createRng(2)
    let differences = 0
    for (let n = 0; n < 100; n++) {
      if (a.uniform(STREAMS.price, n, 'BTC') !== b.uniform(STREAMS.price, n, 'BTC')) {
        differences++
      }
    }
    // Essentially all of them should differ; allow zero collisions in practice.
    expect(differences).toBe(100)
  })

  it('adjacent seeds decorrelate (no obvious structure)', () => {
    // The first draw of seed s vs s+1 should look unrelated, not a tiny shift.
    const d0 = createRng(0).uniform(STREAMS.price, 0, 'BTC')
    const d1 = createRng(1).uniform(STREAMS.price, 0, 'BTC')
    expect(Math.abs(d0 - d1)).toBeGreaterThan(0.01)
  })
})

describe('rng — stream isolation (the Q4 guarantee)', () => {
  it('a coordinate value is independent of any other draws being taken', () => {
    const rng = createRng(7)
    const target = rng.uniform(STREAMS.execHazard, 10, 'quote-A', 0)

    // Take a flood of unrelated draws across every other stream/coordinate.
    let sink = 0
    for (let n = 0; n < 1000; n++) {
      sink += rng.uniform(STREAMS.price, n, 'BTC')
      sink += rng.uniform(STREAMS.maker, n, 'mm-3', 1)
      sink += rng.normal(STREAMS.rfqArrival, n, 'venueX')
      sink += rng.uniform(STREAMS.execHazard, n, 'quote-B', 5) // same stream, diff key
    }
    expect(sink).toBeTypeOf('number')

    // The target coordinate is unchanged — nothing advanced a shared cursor.
    expect(rng.uniform(STREAMS.execHazard, 10, 'quote-A', 0)).toBe(target)
  })

  it('distinct streams at the same (n, key) give distinct values', () => {
    const rng = createRng(99)
    const vals = Object.values(STREAMS).map((s) => rng.uniform(s, 5, 'BTC'))
    expect(new Set(vals).size).toBe(vals.length)
  })

  it('localIdx separates multiple draws sharing one (stream, n, key)', () => {
    const rng = createRng(99)
    const v0 = rng.uniform(STREAMS.book, 3, 'BTC', 0)
    const v1 = rng.uniform(STREAMS.book, 3, 'BTC', 1)
    const v2 = rng.uniform(STREAMS.book, 3, 'BTC', 2)
    expect(new Set([v0, v1, v2]).size).toBe(3)
  })
})

describe('rng — uniform→normal mapping', () => {
  it('normal is exactly the inverse-CDF of the same coordinate uniform (1:1)', () => {
    const rng = createRng(123)
    for (let n = 0; n < 30; n++) {
      const u = rng.uniform(STREAMS.price, n, 'ETH', 4)
      const z = rng.normal(STREAMS.price, n, 'ETH', 4)
      expect(z).toBe(inverseNormalCDF(u))
    }
  })

  it('inverseNormalCDF is monotone and centered', () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 6)
    expect(inverseNormalCDF(0.975)).toBeCloseTo(1.959964, 4) // ~1.96
    expect(inverseNormalCDF(0.025)).toBeCloseTo(-1.959964, 4)
    expect(inverseNormalCDF(0.1)).toBeLessThan(inverseNormalCDF(0.9))
  })

  it('never produces non-finite values at the extremes', () => {
    const rng = createRng(5)
    // Scan many coordinates; all normals must be finite.
    for (let n = 0; n < 5000; n++) {
      expect(Number.isFinite(rng.normal(STREAMS.jump, n, 'X'))).toBe(true)
    }
  })
})

describe('rng — distributional sanity', () => {
  const N = 100000

  it('uniform: mean ≈ 0.5, range in [0,1)', () => {
    const rng = createRng(2024)
    let sum = 0
    let min = Infinity
    let max = -Infinity
    for (let n = 0; n < N; n++) {
      const u = rng.uniform(STREAMS.price, n, 'BTC')
      sum += u
      min = Math.min(min, u)
      max = Math.max(max, u)
    }
    expect(sum / N).toBeCloseTo(0.5, 2)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
  })

  it('normal: mean ≈ 0, std ≈ 1', () => {
    const rng = createRng(2025)
    let sum = 0
    let sumSq = 0
    for (let n = 0; n < N; n++) {
      const z = rng.normal(STREAMS.price, n, 'BTC')
      sum += z
      sumSq += z * z
    }
    const mean = sum / N
    const std = Math.sqrt(sumSq / N - mean * mean)
    expect(mean).toBeCloseTo(0, 1)
    expect(std).toBeCloseTo(1, 1)
  })
})
