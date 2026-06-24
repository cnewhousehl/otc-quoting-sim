// engine/maker.js
//
// Market-maker agent for the Phase-1b agent-MM LOB (PLAN.md §1.8, M11). Each
// maker posts a small limit-order ladder around its OWN perceived fair, with:
//   - perception noise on the hidden mid M_t (sharper makers see fair better),
//   - a base half-spread and a reaction latency (it widens when adversely
//     filled, heals over time),
//   - inventory skew (Avellaneda–Stoikov reservation: r = fair − inv·γ·fair) so
//     a laden maker leans its quotes to offload,
//   - size that thins on the side that would grow its inventory past a limit.
//
// The aggregate of all makers IS the book; toxicity / resilience / skew / impact
// all EMERGE from maker behavior (no parametric knobs). Determinism: perception
// draws come from the `maker` sub-stream keyed by makerId.

import { STREAMS } from './rng.js'

export function createMaker(cfg) {
  let inventory = 0 // signed base position
  let widen = 1 // spread multiplier (>1 after adverse fills), heals toward 1
  let fair = null // perceived fair (tracks M_t with reaction latency)

  // Update the maker's view of fair each tick.
  function reprice(rng, n, M, dt) {
    const perceived = M * Math.exp(cfg.percSigma * rng.normal(STREAMS.maker, n, cfg.id, 0))
    if (fair == null) fair = perceived
    else fair += (perceived - fair) * (1 - Math.exp(-dt / cfg.reactTau)) // lag = reaction latency
    widen += (1 - widen) * 0.03 // spread heals slowly toward base
  }

  // The maker's current limit-order ladder (bids + asks), each tagged with id.
  function quote() {
    const reservation = fair - inventory * cfg.gamma * fair // A–S inventory skew
    const hs = fair * (cfg.halfSpreadBps / 1e4) * widen
    const step = fair * (cfg.levelStepBps / 1e4)
    const sizeBase = cfg.sizeNotional / fair
    const bids = []
    const asks = []
    for (let k = 0; k < cfg.levels; k++) {
      const decay = Math.exp(-k * 0.35)
      const bidSize = sizeBase * decay * Math.max(0.08, 1 - Math.max(0, inventory) / cfg.invLimit)
      const askSize = sizeBase * decay * Math.max(0.08, 1 - Math.max(0, -inventory) / cfg.invLimit)
      bids.push({ price: reservation - hs - k * step, size: bidSize, makerId: cfg.id })
      asks.push({ price: reservation + hs + k * step, size: askSize, makerId: cfg.id })
    }
    return { bids, asks }
  }

  // dir: 'bought' (maker's bid lifted) | 'sold' (maker's ask hit).
  function onFill(dir, size) {
    inventory += dir === 'bought' ? size : -size
    widen += 0.18 // got picked off → widen up
    // infer the taker may be informed → nudge perceived fair toward the flow
    // (emergent Kyle-λ permanent impact).
    if (fair != null) fair *= Math.exp((dir === 'sold' ? 1 : -1) * (cfg.infoNudge ?? 0) * (size / cfg.invLimit))
  }

  return {
    id: cfg.id,
    reprice,
    quote,
    onFill,
    get inventory() {
      return inventory
    },
    get fair() {
      return fair
    },
  }
}
