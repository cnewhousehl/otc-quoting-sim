// test/toxicity.test.js — M7 venue reaction to one-sided flow.
import { describe, it, expect } from 'vitest'
import { createToxicity } from '../engine/toxicity.js'

const cfg = { tau: 8, dt: 0.25, refFlow: 10, kSpread: 1.0, kDepth: 0.8, kSkew: 5 }

describe('toxicity', () => {
  it('sustained one-sided flow widens the spread, then it heals when flow stops', () => {
    const t = createToxicity(cfg)
    expect(t.spreadMult('V')).toBeCloseTo(1, 6) // neutral at rest
    for (let i = 0; i < 5; i++) t.observe('V', 8) // student keeps buying
    const widened = t.spreadMult('V')
    expect(widened).toBeGreaterThan(1.2)
    for (let i = 0; i < 400; i++) t.decayAll()
    expect(t.spreadMult('V')).toBeCloseTo(1, 3) // healed
  })

  it('thins the hit side and leaves the other side alone', () => {
    const t = createToxicity(cfg)
    for (let i = 0; i < 5; i++) t.observe('V', 8) // buying → lifting asks
    expect(t.depthMult('V', 'ask')).toBeLessThan(0.9) // ask side thins
    expect(t.depthMult('V', 'bid')).toBeCloseTo(1, 6) // bid side untouched
  })

  it('skews the mid away from the flow (buying pushes the venue mid up)', () => {
    const t = createToxicity(cfg)
    for (let i = 0; i < 5; i++) t.observe('V', 8)
    expect(t.skew('V')).toBeGreaterThan(0)
    const t2 = createToxicity(cfg)
    for (let i = 0; i < 5; i++) t2.observe('V', -8) // selling
    expect(t2.skew('V')).toBeLessThan(0)
  })

  it('is neutral with zero sensitivities (M3-equivalent)', () => {
    const t = createToxicity({ tau: 8, dt: 0.25, refFlow: 10 })
    for (let i = 0; i < 10; i++) t.observe('V', 8)
    expect(t.spreadMult('V')).toBe(1)
    expect(t.skew('V')).toBe(0)
    expect(t.depthMult('V', 'ask')).toBe(1)
  })
})
