// test/resilience.test.js — M7 depth regrowth.
import { describe, it, expect } from 'vitest'
import { createResilience } from '../engine/resilience.js'

describe('resilience', () => {
  it('consume depletes, regrow heals back toward full depth', () => {
    const r = createResilience({ tau: 4, dt: 0.25 })
    r.consume('V:ask', 0.5)
    expect(r.get('V:ask')).toBeCloseTo(0.5, 6)
    const afterOne = (() => {
      r.regrow()
      return r.get('V:ask')
    })()
    expect(afterOne).toBeGreaterThan(0.5) // healing
    for (let i = 0; i < 500; i++) r.regrow()
    expect(r.get('V:ask')).toBeCloseTo(1, 6) // fully recovered
  })

  it('repeated sweeps without pause keep depth depleted; pauses recover it', () => {
    const sweep = createResilience({ tau: 8, dt: 0.25 })
    for (let i = 0; i < 6; i++) sweep.consume('V:ask', 0.2) // no regrow between
    const swept = sweep.get('V:ask')

    const clip = createResilience({ tau: 8, dt: 0.25 })
    for (let i = 0; i < 6; i++) {
      clip.consume('V:ask', 0.2)
      for (let t = 0; t < 8; t++) clip.regrow() // pause between clips
    }
    const clipped = clip.get('V:ask')

    expect(swept).toBeLessThan(clipped) // sweeping leaves you thinner than clipping
  })

  it('with no τ regrows instantly (M3-equivalent full depth)', () => {
    const r = createResilience({ dt: 0.25 })
    r.consume('V:ask', 0.7)
    r.regrow()
    expect(r.get('V:ask')).toBe(1)
  })

  it('never depletes below the floor', () => {
    const r = createResilience({ tau: 4, dt: 0.25, floor: 0.05 })
    for (let i = 0; i < 50; i++) r.consume('V:ask', 0.5)
    expect(r.get('V:ask')).toBeGreaterThanOrEqual(0.05)
  })
})
