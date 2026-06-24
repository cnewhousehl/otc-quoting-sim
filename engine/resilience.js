// engine/resilience.js
//
// Consumed depth regrows toward steady state (PLAN.md §1.1 resilience.js, M7).
// Each venue side carries a depth multiplier in (floor, 1]: available depth =
// mult · steady depth. A marketable trade depletes it; each tick it regrows
// toward 1 with venue time-constant τ_v. → small clips with pauses beat one
// sweep (sweep deeply depletes; pausing lets it heal).
//
// Phase 1b note: this becomes emergent from makers re-posting (M11); here it's
// the parametric baseline. With no τ it regrows instantly (M3-equivalent).

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

export function createResilience({ tau, dt, floor = 0.05 }) {
  const instant = !tau || tau <= 0
  const alpha = instant ? 1 : 1 - Math.exp(-dt / tau) // regrow fraction per tick
  const mult = new Map()

  const get = (key) => mult.get(key) ?? 1

  // Regrow every depleted side toward full depth.
  function regrow() {
    if (instant) {
      mult.clear() // back to full each tick
      return
    }
    for (const [k, v] of mult) mult.set(k, v + (1 - v) * alpha)
  }

  // Deplete a side by `fraction` of its steady depth (fraction = filled/steady).
  function consume(key, fraction) {
    mult.set(key, clamp(get(key) - fraction, floor, 1))
  }

  return { get, regrow, consume, _mult: mult }
}
