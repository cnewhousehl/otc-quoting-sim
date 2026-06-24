// engine/news.js
//
// News scheduler + drift generator (M9.5). On a timer (every intervalMin,
// configurable 1–10), a catalyst fires and pivots the hidden true mid M_t over a
// horizon via a smooth (half-sine) drift path injected in RETURN space — exactly
// the same injection channel as toxic drift, so it superposes. Because the move
// is gradual, the venue books (and the M11 makers) follow it slowly rather than
// gapping — students can read the tape and position into it.

import { STREAMS } from './rng.js'
import { MAGNITUDE, NEWS_CATALOGUE } from '../config/news.js'

export function createNewsEngine({ rng, dt, assetIds, intervalMin = 3, catalogue = NEWS_CATALOGUE }) {
  const clampInterval = (m) => Math.min(10, Math.max(1, m))
  let intervalTicks = Math.round((clampInterval(intervalMin) * 60) / dt)
  const active = [] // { assets:Set, path, startTick }
  const fireTicks = [] // ticks at which catalysts fired (for digestion stress)
  let nextAt = intervalTicks
  let seq = 0
  const W_PRE = Math.max(1, Math.round(20 / dt)) // anticipation window (~20s before)
  const W_POST = Math.max(1, Math.round(45 / dt)) // digestion window (~45s after)

  // Smooth half-sine bump of per-tick returns summing to `total` over H ticks
  // (starts slow, peaks, eases — a "pivot", not a gap).
  function buildPath(total, H) {
    const raw = []
    let Z = 0
    for (let k = 0; k < H; k++) {
      const w = Math.sin((Math.PI * (k + 0.5)) / H)
      raw.push(w)
      Z += w
    }
    return raw.map((w) => (total * w) / Z)
  }

  // Advance one tick; returns a fired news event or null.
  function step(n) {
    if (n < nextAt) return null
    const u = rng.uniform(STREAMS.news, n, 'pick', 0)
    const cat = catalogue[Math.min(catalogue.length - 1, Math.floor(u * catalogue.length))]
    const mag = MAGNITUDE[cat.magnitude]
    const total = mag.totalReturn * cat.direction
    const H = Math.max(1, Math.round(mag.horizonSec / dt))
    const assets = cat.scope === 'macro' ? assetIds : cat.assets.filter((a) => assetIds.includes(a))
    active.push({ assets: new Set(assets), path: buildPath(total, H), startTick: n + 1 })

    fireTicks.push(n)
    while (fireTicks.length && n - fireTicks[0] > W_POST) fireTicks.shift()
    const j = rng.uniform(STREAMS.news, n, 'jitter', 0)
    nextAt = n + Math.round(intervalTicks * (0.8 + 0.4 * j)) // ±20% jitter
    return {
      id: `news${++seq}`,
      tick: n,
      catId: cat.id,
      headline: cat.headline,
      scope: cat.scope,
      assets,
      direction: cat.direction,
      magnitude: cat.magnitude,
      totalReturn: total,
      horizonTicks: H,
    }
  }

  // Per-asset return injection for tick n (summed across active catalysts).
  function injectionAt(n) {
    const out = {}
    for (const ev of active) {
      const k = n - ev.startTick
      if (k >= 0 && k < ev.path.length) {
        for (const a of ev.assets) out[a] = (out[a] ?? 0) + ev.path[k]
      }
    }
    return out
  }

  // Market stress in [0,1]: ramps up approaching the next catalyst (anticipation)
  // and decays after recent ones (digestion). Drives wider spreads / thinner
  // depth around news — which in turn lets clients accept wider quotes (the
  // hedge cost widens too).
  function stressAt(n) {
    let s = 0
    const tn = nextAt - n
    if (tn >= 0 && tn < W_PRE) s = Math.max(s, 1 - tn / W_PRE)
    for (const ft of fireTicks) {
      const d = n - ft
      if (d >= 0 && d < W_POST) s = Math.max(s, 1 - d / W_POST)
    }
    return s
  }

  const ticksToNext = (n) => Math.max(0, nextAt - n)
  function setIntervalMin(m) {
    intervalTicks = Math.round((clampInterval(m) * 60) / dt)
  }

  return { step, injectionAt, stressAt, ticksToNext, setIntervalMin, _active: active }
}

// Merge two per-asset injection maps (toxic drift + news).
export function mergeInjections(a, b) {
  const out = { ...a }
  for (const k of Object.keys(b)) out[k] = (out[k] ?? 0) + b[k]
  return out
}
