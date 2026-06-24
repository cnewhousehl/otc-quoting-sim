// test/entitlements.test.js — licensing/feature-gating tiers.
import { describe, it, expect } from 'vitest'
import { can, allowedDifficulties, gateSessionConfig, getTier, resolveActiveTier, DEFAULT_TIER } from '../config/entitlements.js'

describe('entitlements — capabilities', () => {
  it('free unlocks easy/medium but gates hard + custom config', () => {
    expect(can('free', 'difficulty', 'easy')).toBe(true)
    expect(can('free', 'difficulty', 'medium')).toBe(true)
    expect(can('free', 'difficulty', 'hard')).toBe(false)
    expect(can('free', 'customConfig')).toBe(false)
    expect(can('free', 'replayExport')).toBe(false)
  })

  it('pro unlocks hard, custom config, all scenarios, replay export', () => {
    expect(can('pro', 'difficulty', 'hard')).toBe(true)
    expect(can('pro', 'customConfig')).toBe(true)
    expect(can('pro', 'scenario', 'toxic-day')).toBe(true)
    expect(can('pro', 'replayExport')).toBe(true)
  })

  it('allowedDifficulties reflects the tier', () => {
    expect(allowedDifficulties('free')).toEqual(['easy', 'medium'])
    expect(allowedDifficulties('pro')).toContain('hard')
  })
})

describe('entitlements — session config gating', () => {
  it('downgrades a hard request to the best allowed (medium) on free, and reports it', () => {
    const { config, gated } = gateSessionConfig({ difficulty: 'hard', seed: 7 }, 'free')
    expect(config.difficulty).toBe('medium')
    expect(config.seed).toBe(7) // untouched fields pass through
    expect(gated).toHaveLength(1)
    expect(gated[0]).toMatchObject({ feature: 'difficulty', requested: 'hard', fallback: 'medium' })
  })

  it('strips custom config + clamps session length on free', () => {
    const { config, gated } = gateSessionConfig({ difficulty: 'easy', custom: { sigma: 9 }, sessionMinutes: 60 }, 'free')
    expect(config.custom).toBeUndefined()
    expect(config.sessionMinutes).toBe(10)
    expect(gated.map((g) => g.feature).sort()).toEqual(['customConfig', 'sessionMinutes'])
  })

  it('caps assets/venues on free', () => {
    const { config, gated } = gateSessionConfig(
      { difficulty: 'easy', assets: ['BTC', 'ETH', 'SOL'], venues: ['A', 'B', 'C'] },
      'free',
    )
    expect(config.assets).toEqual(['BTC'])
    expect(config.venues).toEqual(['A', 'B'])
    expect(gated.map((g) => g.feature).sort()).toEqual(['maxAssets', 'maxVenues'])
  })

  it('passes a fully-entitled config through untouched on pro', () => {
    const req = { difficulty: 'hard', custom: { sigma: 9 }, scenario: 'toxic-day', sessionMinutes: 30, assets: ['BTC', 'ETH'] }
    const { config, gated } = gateSessionConfig(req, 'pro')
    expect(gated).toHaveLength(0)
    expect(config).toMatchObject(req)
  })
})

describe('entitlements — tier resolution', () => {
  it('defaults to free and ignores URL override unless explicitly allowed', () => {
    expect(resolveActiveTier().id).toBe(DEFAULT_TIER)
    expect(resolveActiveTier({ urlParam: 'pro' }).id).toBe('free') // not allowed by default
    expect(resolveActiveTier({ urlParam: 'pro', allowUrlOverride: true }).id).toBe('pro')
    expect(resolveActiveTier({ env: 'instructor' }).id).toBe('instructor')
  })

  it('unknown tier falls back to free', () => {
    expect(getTier('nope').id).toBe('free')
  })
})
