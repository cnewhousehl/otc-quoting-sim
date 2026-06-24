// engine/fill.js
//
// Hedge-cost-anchored execution model (PLAN.md §1.2, Q2; redesigned).
//
// The probability a client trades your quote is anchored to what it costs YOU to
// hedge their size on the live book — not a static width. A client's reservation
// (the spread over fair they'll accept) is:
//
//   reservation = hedgeCost + archetype_buffer  (± bias shift per side)
//
//   - Sharp (Citadel-like): tiny buffer + STEEP cutoff → they only trade near the
//     hedgeable price + a small spread; they almost never let you fill them wide
//     unless their clip is huge vs the book (hedgeCost itself is large).
//   - Mid: moderate buffer, gentler slope (pays less attention to exact liquidity).
//   - Soft/retail: large buffer, gradual slope (trades wide).
//
// Because the reservation tracks the LIVE hedge cost (which moves as books widen,
// deplete, and react to flow), the "right" quote width is not memorizable — the
// student must read the book. A stale quote (w<0, in the client's favor) sits
// deep inside reservation, so g→1 and it gets picked off. Bias shifts the per-side
// reservation (bullish → accepts a wider ask). Staleness severity for P&L still
// uses σ_M.

import { STREAMS } from './rng.js'

const logistic = (x) => 1 / (1 + Math.exp(-x))

// Willingness in [floor, 1]: 1 when your spread w is well inside reservation
// (or stale), decaying to floor as w exceeds it. `slope` sets the cutoff sharpness.
export function fillG({ w, reservation, slope, floor }) {
  return floor + (1 - floor) * logistic((reservation - w) / slope)
}

// Evaluate one live quote against the current mid at tick n.
//   client.fill   = { bufferBps, slopeBps, floor }  (archetype shape)
//   client.hedgeWidth = cost (price) to hedge the clip on the cheapest venue
//   client.lambda, client.bias, client.biasGainBps, client.tauReact
export function evaluateQuoteFill({ quote, mid, sigmaM, n, dt, rng, client, diff }) {
  const ageSec = (n - quote.createdTick) * dt
  if (ageSec <= 0) return null // decision latency: no fill on the creation tick

  const f = client.fill
  // Relationship favor widens (or narrows) the buffer: a well-treated client
  // accepts a wider quote; a wary one demands tighter.
  const buffer = mid * (f.bufferBps / 1e4) * (1 + (client.favorBonus ?? 0))
  const slope = mid * (f.slopeBps / 1e4)
  const hedge = client.hedgeWidth ?? buffer
  const biasShift = mid * ((client.biasGainBps ?? 0) / 1e4) * (client.bias ?? 0)
  const resAsk = hedge + buffer + biasShift // bullish → tolerates a wider ask (lift)
  const resBid = hedge + buffer - biasShift // bearish → tolerates a wider bid (hit)

  const wAsk = quote.ask - mid // your ask half-spread over fair (neg = stale ITM)
  const wBid = mid - quote.bid

  const Rdur = 1 - Math.exp(-ageSec / (client.tauReact ?? 2)) // decision-latency ramp
  const dDiff = diff?.dDiff ?? 1
  // Bias also tilts which side fires first (a bullish client lifts; bearish hits).
  const bf = Math.exp(0.7 * (client.bias ?? 0))
  const gAsk = fillG({ w: wAsk, reservation: resAsk, slope, floor: f.floor })
  const gBid = fillG({ w: wBid, reservation: resBid, slope, floor: f.floor })
  const pAsk = 1 - Math.exp(-client.lambda * gAsk * bf * Rdur * dDiff * dt)
  const pBid = 1 - Math.exp((-client.lambda * gBid * Rdur * dDiff * dt) / bf)

  const uAsk = rng.uniform(STREAMS.execHazard, n, quote.id, 0)
  const uBid = rng.uniform(STREAMS.execHazard, n, quote.id, 1)
  const askFires = uAsk < pAsk
  const bidFires = uBid < pBid
  if (!askFires && !bidFires) return null

  // staleness edge (σ_M) — drives fill severity / adverse-selection attribution
  const eStaleAsk = (mid - quote.ask) / sigmaM
  const eStaleBid = (quote.bid - mid) / sigmaM
  let side
  if (askFires && bidFires) side = eStaleAsk >= eStaleBid ? 'ask' : 'bid'
  else side = askFires ? 'ask' : 'bid'

  if (side === 'ask') return { side: 'ask', clientBuys: true, price: quote.ask, edge: eStaleAsk }
  return { side: 'bid', clientBuys: false, price: quote.bid, edge: eStaleBid }
}
