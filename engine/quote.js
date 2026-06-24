// engine/quote.js
//
// Live-quote lifecycle (PLAN.md §1.1 quote.js, §1.2, M5).
//
// A student two-way (bid, ask) for an RFQ becomes a LIVE object with a TTL
// (default 120 ticks = 30 s) and is executable at those prices until it is
// cancelled ("off"), refreshed (re-quoted at new fair), filled, or expires.
//
// States: live → filled / cancelled / expired. A refresh keeps the quote live
// but swaps in new prices and resets its age (collapsing the staleness edge back
// to −w/σ — the defensive move the staleness lesson is about).

export const QUOTE_STATE = Object.freeze({
  live: 'live',
  filled: 'filled',
  cancelled: 'cancelled',
  expired: 'expired',
})

export function createQuoteBook({ ttlTicks = 120 } = {}) {
  const quotes = new Map()
  let seq = 0

  function submit({ rfqId, assetId, clientId, archetype, bid, ask, size, tick }) {
    const id = `q${++seq}`
    const q = {
      id,
      rfqId,
      assetId,
      clientId,
      archetype,
      bid,
      ask,
      size,
      createdTick: tick, // age clock; reset on refresh
      submittedTick: tick, // original submission (never reset)
      ttlTicks,
      state: QUOTE_STATE.live,
      refreshCount: 0,
      history: [],
      fill: null,
      closedTick: null,
    }
    quotes.set(id, q)
    return q
  }

  const get = (id) => quotes.get(id)
  const all = () => [...quotes.values()]
  const live = () => all().filter((q) => q.state === QUOTE_STATE.live)
  const ageTicks = (q, tick) => tick - q.createdTick

  function cancel(id, tick) {
    const q = quotes.get(id)
    if (q && q.state === QUOTE_STATE.live) {
      q.state = QUOTE_STATE.cancelled
      q.closedTick = tick
    }
    return q
  }

  // Re-quote at new prices. Stays live; resets the age clock so the staleness
  // edge collapses back to fresh.
  function refresh(id, { bid, ask }, tick) {
    const q = quotes.get(id)
    if (q && q.state === QUOTE_STATE.live) {
      q.history.push({ bid: q.bid, ask: q.ask, fromTick: q.createdTick, toTick: tick })
      q.bid = bid
      q.ask = ask
      q.createdTick = tick
      q.refreshCount += 1
    }
    return q
  }

  function markFilled(id, info, tick) {
    const q = quotes.get(id)
    if (q && q.state === QUOTE_STATE.live) {
      q.state = QUOTE_STATE.filled
      q.fill = info
      q.closedTick = tick
    }
    return q
  }

  // Move any live quote past its TTL to expired; returns the ones expired now.
  function expireDue(tick) {
    const out = []
    for (const q of quotes.values()) {
      if (q.state === QUOTE_STATE.live && tick - q.createdTick >= q.ttlTicks) {
        q.state = QUOTE_STATE.expired
        q.closedTick = tick
        out.push(q)
      }
    }
    return out
  }

  return { submit, get, all, live, ageTicks, cancel, refresh, markFilled, expireDue }
}
