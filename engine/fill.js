// engine/fill.js
//
// Continuous per-tick execution hazard (PLAN.md §1.2, Q2, M5).
//
// Each tick, for every live quote, the issuing client may execute against the
// still-live price. The per-side hazard intensity is
//
//   h_side = λ_C · g_arch(e_side) · L(X) · R_dur(τ) · D_diff
//
// with per-tick fill probability 1 − exp(−h·dt). Edges are normalized by σ_M so
// they're dimensionless:
//   e_ask = (M_t − studentAsk)/σ_M   (client lifts/buys at the ask)
//   e_bid = (studentBid − M_t)/σ_M   (client hits/sells at the bid)
// e > 0 means the quote has gone stale in-the-money to the client (pickoff zone).
//
// Bid-fill and ask-fill are independent competing risks on the same quote; the
// first to fire consumes it, and a same-tick tie goes to the larger edge
// (deterministic, no extra draw). The soft archetype lives here; the sharp
// (softplus pickoff) archetype is added in M6.
//
// This module is pure math — all coefficients come in via `client`/`diff`, so
// difficulty (M9) and calibration (M10) tune behavior without touching it.

import { STREAMS } from './rng.js'

const logistic = (x) => 1 / (1 + Math.exp(-x))
const softplus = (x) => (x > 30 ? x : Math.log1p(Math.exp(x))) // overflow-safe
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

// Soft (uninformed) archetype: large floor s0 ⇒ still trades when e<0 (the
// spread-capture engine), roughly flat in e.
//   g_soft(e) = s0 + s1·logistic((e + ω_soft)/b_soft)
export function softG(e, { s0, s1, omega, b }) {
  return s0 + s1 * logistic((e + omega) / b)
}

// Sharp (informed) archetype: tiny baseline q0, hazard spikes once the quote
// goes stale-in-the-money. Used from M6 onward.
//   g_sharp(e) = q0 + A_pick·softplus((e − θ_sharp)/b_sharp)
export function sharpG(e, { q0, aPick, theta, b }) {
  return q0 + aPick * softplus((e - theta) / b)
}

export function archetypeG(e, client) {
  if (client.archetype === 'sharp') return sharpG(e, client.sharp)
  return softG(e, client.soft)
}

// Per-side hazard intensity (per second).
export function fillHazard({ e, ageSec, size, client, diff }) {
  const g = archetypeG(e, client)
  const L = clamp(
    Math.pow(size / client.xRef, -client.eta),
    client.Lmin ?? 0.25,
    client.Lmax ?? 4,
  )
  const Rdur = 1 - Math.exp(-ageSec / client.tauReact) // decision latency ramp
  const Ddiff = diff?.dDiff ?? 1
  return client.lambda * g * L * Rdur * Ddiff
}

// Evaluate one live quote against the current mid at tick n. Returns a fill
// descriptor or null (no fill this tick).
//   { side, clientBuys, price, edge }
// side 'ask' → client buys at the ask (student sells); 'bid' → client sells.
export function evaluateQuoteFill({ quote, mid, sigmaM, n, dt, rng, client, diff }) {
  const ageSec = (n - quote.createdTick) * dt
  if (ageSec <= 0) return null // decision latency: no fill on the creation tick

  const eAsk = (mid - quote.ask) / sigmaM
  const eBid = (quote.bid - mid) / sigmaM

  const hAsk = fillHazard({ e: eAsk, ageSec, size: quote.size, client, diff })
  const hBid = fillHazard({ e: eBid, ageSec, size: quote.size, client, diff })
  const pAsk = 1 - Math.exp(-hAsk * dt)
  const pBid = 1 - Math.exp(-hBid * dt)

  const uAsk = rng.uniform(STREAMS.execHazard, n, quote.id, 0)
  const uBid = rng.uniform(STREAMS.execHazard, n, quote.id, 1)
  const askFires = uAsk < pAsk
  const bidFires = uBid < pBid

  if (!askFires && !bidFires) return null

  let side
  if (askFires && bidFires) side = eAsk >= eBid ? 'ask' : 'bid'
  else side = askFires ? 'ask' : 'bid'

  if (side === 'ask') {
    return { side: 'ask', clientBuys: true, price: quote.ask, edge: eAsk }
  }
  return { side: 'bid', clientBuys: false, price: quote.bid, edge: eBid }
}
