// config/entitlements.js
//
// Licensing / feature-gating tiers (forward-looking: this is intended to be
// licensed as training software to firms). A single "tier" gates what a build
// can do. The free-to-play web deploy defaults to `free`; licensed firm builds
// run `pro`/`instructor`.
//
// IMPORTANT: client-side gating is a PRODUCT-TIER mechanism, not a security
// boundary — a determined user can edit JS. Licensed builds must validate the
// license key SERVER-SIDE and ship the entitled tier from a trusted origin.
// This module is the single source of truth for "what does tier X unlock", so
// both the UI (show/lock affordances) and the engine (gate session config) agree.

export const TIERS = {
  free: {
    id: 'free',
    label: 'Free-to-Play',
    // Teaching value with the toxic-flow lesson intact, but Hard + customization
    // are the paid hooks.
    difficulties: ['easy', 'medium'], // Hard is licensed
    customConfig: false, // can't hand-tune coefficients
    scenarios: ['calm'], // single scenario
    maxAssets: 1,
    maxVenues: 2,
    maxSessionMinutes: 10,
    grading: 'summary', // basic scorecard, no full benchmark breakdown
    replayExport: false, // no event-log / replay download
    whiteLabel: false,
  },
  pro: {
    id: 'pro',
    label: 'Licensed — Firm',
    difficulties: ['easy', 'medium', 'hard'],
    customConfig: true, // full difficulty/scenario coefficient overrides
    scenarios: ['calm', 'trending', 'vol-spike', 'toxic-day'],
    maxAssets: Infinity,
    maxVenues: Infinity,
    maxSessionMinutes: Infinity,
    grading: 'full', // full benchmark-relative scorecard (Phase 3)
    replayExport: true, // download event log for instructor replay
    whiteLabel: true, // firm branding
  },
  instructor: {
    id: 'instructor',
    label: 'Licensed — Instructor',
    difficulties: ['easy', 'medium', 'hard'],
    customConfig: true,
    scenarios: ['calm', 'trending', 'vol-spike', 'toxic-day'],
    maxAssets: Infinity,
    maxVenues: Infinity,
    maxSessionMinutes: Infinity,
    grading: 'full',
    replayExport: true,
    whiteLabel: true,
    cohortTools: true, // assign seeds to a class, aggregate scorecards
    authoring: true, // author custom scenarios/rosters
  },
}

export const DEFAULT_TIER = 'free'

export function getTier(id) {
  return TIERS[id] ?? TIERS[DEFAULT_TIER]
}

// Capability check. Examples:
//   can('free', 'difficulty', 'hard')  → false
//   can('pro', 'customConfig')         → true
//   can(tierObj, 'scenario', 'toxic-day')
export function can(tier, feature, value) {
  const t = typeof tier === 'string' ? getTier(tier) : tier
  switch (feature) {
    case 'difficulty':
      return t.difficulties.includes(value)
    case 'scenario':
      return t.scenarios.includes(value)
    default:
      return Boolean(t[feature])
  }
}

export function allowedDifficulties(tier) {
  return (typeof tier === 'string' ? getTier(tier) : tier).difficulties.slice()
}

// Gate a requested session config against a tier. NEVER throws — it degrades to
// the best allowed config and returns `gated`, a list of what was downgraded so
// the UI can show an honest upsell ("Hard mode is a licensed feature").
export function gateSessionConfig(requested = {}, tier = DEFAULT_TIER) {
  const t = typeof tier === 'string' ? getTier(tier) : tier
  const out = { ...requested }
  const gated = []

  if (out.difficulty && !t.difficulties.includes(out.difficulty)) {
    const fallback = t.difficulties[t.difficulties.length - 1]
    gated.push({ feature: 'difficulty', requested: out.difficulty, allowed: t.difficulties.slice(), fallback })
    out.difficulty = fallback
  }

  if (out.custom && !t.customConfig) {
    gated.push({ feature: 'customConfig', requested: true, allowed: false })
    delete out.custom
  }

  // Agent-MM books (M11) are a power feature gated behind the same entitlement
  // as hand-tuned configs; lower tiers fall back to the parametric book.
  if (out.bookStyle === 'agent' && !t.customConfig) {
    gated.push({ feature: 'bookStyle', requested: 'agent', allowed: false, fallback: 'parametric' })
    out.bookStyle = 'parametric'
  }

  if (out.scenario && !t.scenarios.includes(out.scenario)) {
    const fallback = t.scenarios[0]
    gated.push({ feature: 'scenario', requested: out.scenario, allowed: t.scenarios.slice(), fallback })
    out.scenario = fallback
  }

  if (Number.isFinite(t.maxSessionMinutes) && out.sessionMinutes > t.maxSessionMinutes) {
    gated.push({ feature: 'sessionMinutes', requested: out.sessionMinutes, allowed: t.maxSessionMinutes })
    out.sessionMinutes = t.maxSessionMinutes
  }

  if (Array.isArray(out.assets) && out.assets.length > t.maxAssets) {
    gated.push({ feature: 'maxAssets', requested: out.assets.length, allowed: t.maxAssets })
    out.assets = out.assets.slice(0, t.maxAssets)
  }

  if (Array.isArray(out.venues) && out.venues.length > t.maxVenues) {
    gated.push({ feature: 'maxVenues', requested: out.venues.length, allowed: t.maxVenues })
    out.venues = out.venues.slice(0, t.maxVenues)
  }

  return { config: out, gated }
}

// Resolve the active tier for a build. Free web deploy → DEFAULT_TIER. Licensed
// builds override via an injected tier id (from a server-validated license or a
// build-time env). `urlParam` is honored only for demos/dev, never as real auth.
export function resolveActiveTier({ urlParam, env, allowUrlOverride = false } = {}) {
  const id = (allowUrlOverride && urlParam) || env || DEFAULT_TIER
  return getTier(id)
}
