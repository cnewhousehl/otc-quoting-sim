# /config — tunable presets

All instructor-tunable knobs live here as a single config object so the engine can be calibrated
without touching engine code (see [`../PLAN.md`](../PLAN.md) §1.3–§1.5).

Planned:

- `difficulty.js` — Easy / Medium / Hard parameter bundles (toxic share `p_tox`, fill-vs-width
  sensitivity `β`, stale-pickoff aggression, post-fill drift `δ_tox`, `maxPendingRFQs`, arrival rate
  `λ`, name→toxicity transparency).
- `clients.js` — named client archetype roster (sharp/toxic, mid, soft) with reservation spread,
  informed-probability, pickoff aggression, size profile. Invented desk-style handles only.
- `session.js` — session length, scenario {calm, trending, vol-spike, toxic-day}, quote TTL, asset
  universe (per-tier vol/depth/spread/τ/λ_v/φ), fees, soft inventory limit.
