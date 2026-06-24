// engine/session.js
//
// The session orchestrator (PLAN.md §1.6, Q4/Q5, M9). Wires config + scenario +
// difficulty + entitlements into one headless, seed-deterministic state machine,
// owns the replayable event log, and exposes the public API the UI (Phase 2) and
// grader (Phase 3) consume.
//
// Per-tick loop (Q4 order): apply actions → advance M_t (GBM + active toxic
// drift) → books/resilience → inventory MtM accounting → create RFQ → expire
// quotes/RFQs → execution hazard (ascending quoteId) → events. Draws are
// addressed by stable entity key, so the log is a pure function of
// (seed, config, actions) — replayable byte-for-byte.

import { createRng } from './rng.js'
import { createPriceProcess } from './price.js'
import { createBook } from './book.js'
import { createPnL } from './pnl.js'
import { createQuoteBook } from './quote.js'
import { evaluateQuoteFill } from './fill.js'
import { resolveClient, buildDriftPath, createToxicDrift } from './client.js'
import { createRfqGenerator } from './rfq.js'
import { getDifficulty } from '../config/difficulty.js'
import { clientById, ROSTER } from '../config/clients.js'
import { assetLiquidityNotional } from '../config/venues.js'
import { gateSessionConfig } from '../config/entitlements.js'
import { DEFAULT_SESSION, buildSessionWorld } from '../config/session.js'

const quoteNum = (id) => Number(id.slice(1)) // 'q12' -> 12

export function createSession({ seed, difficulty = 'medium', tier = 'free', config = {} } = {}) {
  // Entitlement gate first — Hard/custom/etc. degrade to the tier's best allowed.
  const { config: gatedReq, gated } = gateSessionConfig({ difficulty, ...config }, tier)
  const cfg = { ...DEFAULT_SESSION, ...config, ...gatedReq }
  const diff = getDifficulty(cfg.difficulty)
  const diffHaz = { dDiff: diff.hazardScale }
  const dt = cfg.dt

  const { assets, venues, universe } = buildSessionWorld(cfg)
  const rng = createRng(seed)
  const price = createPriceProcess({ rng, dt, assets })
  const book = createBook({ rng, price, venues, dt })
  const pnl = createPnL()
  const quotes = createQuoteBook({ ttlTicks: cfg.ttlTicks })
  const toxicDrift = createToxicDrift()
  const rfqGen = createRfqGenerator({ rng, dt, difficulty: diff, universe, roster: ROSTER, liquidityNotional: assetLiquidityNotional })

  const assetIds = price.assetIds()
  for (const id of assetIds) pnl.setMark(id, price.mid(id))
  book.tick(0)

  const totalTicks = Math.round((cfg.sessionMinutes * 60) / dt)
  let n = 0
  let done = false
  const log = []
  const rfqs = new Map() // rfqId -> rfq (all)
  const pending = new Map() // rfqId -> rfq awaiting a quote (counts toward cap)
  const quoteByRfq = new Map() // rfqId -> quoteId

  function emit(rec) {
    const full = { tick: n, ...rec }
    log.push(full)
    return full
  }

  // ---- actions (applied immediately at the current tick; logged) -------------
  function submitQuote(rfqId, { bid, ask }) {
    const rfq = pending.get(rfqId) ?? rfqs.get(rfqId)
    if (!rfq || quoteByRfq.has(rfqId)) return null
    const q = quotes.submit({ rfqId, assetId: rfq.assetId, clientId: rfq.clientId, archetype: rfq.archetype, bid, ask, size: rfq.size, tick: n })
    quoteByRfq.set(rfqId, q.id)
    pending.delete(rfqId)
    emit({ type: 'quote_submit', quoteId: q.id, rfqId, assetId: rfq.assetId, clientId: rfq.clientId, bid, ask, sizeX: rfq.size })
    return q
  }
  function cancelQuote(rfqId) {
    const qid = quoteByRfq.get(rfqId)
    if (!qid) return
    quotes.cancel(qid, n)
    emit({ type: 'quote_cancel', quoteId: qid, rfqId })
    closeRfq(rfqId)
  }
  function refreshQuote(rfqId, { bid, ask }) {
    const qid = quoteByRfq.get(rfqId)
    if (!qid) return
    quotes.refresh(qid, { bid, ask }, n)
    emit({ type: 'quote_refresh', quoteId: qid, rfqId, bid, ask })
  }
  function hedge({ assetId, venueId, side, size }) {
    const r = book.executeMarketable({ venueId, side, size })
    const fee = (r.vwap * r.filledSize * cfg.hedgeFeeBps) / 1e4
    pnl.onHedge({ assetId, buy: side === 'buy', size: r.filledSize, vwap: r.vwap, fee, meta: { venueId } })
    emit({
      type: 'hedge', assetId, venueId, side, sizeX: r.filledSize, vwap: r.vwap,
      fairMid_at_event: price.mid(assetId), hedgeSlippage: r.slippage, fees: fee, cash_after: snapshotCash(),
    })
    return r
  }

  function closeRfq(rfqId) {
    pending.delete(rfqId)
  }

  // ---- the tick --------------------------------------------------------------
  function tick() {
    if (done) return []
    const events = []

    // (2-3) advance true mid with any active toxic drift + GBM + jumps
    const midBefore = {}
    for (const id of assetIds) midBefore[id] = price.mid(id)
    price.step(n, toxicDrift.injectionAt(n))

    // (4) books + resilience/toxicity decay
    book.tick(n)

    // (8a) inventory mark-to-market from this tick's mid move (split GBM vs tox)
    const attr = {}
    for (const id of assetIds) {
      const c = price.components(id)
      attr[id] = { midBefore: midBefore[id], midAfter: price.mid(id), rGBM: c.rGBM }
    }
    pnl.onTick(attr)

    // (5) create an RFQ (toxicity pre-sampled at creation)
    const rfq = rfqGen.step(n, pending.size)
    if (rfq) {
      rfqs.set(rfq.id, rfq)
      pending.set(rfq.id, rfq)
      events.push(emit({ type: 'rfq_new', rfqId: rfq.id, clientId: rfq.clientId, handle: rfq.handle, archetype: rfq.archetype, isToxic: rfq.isToxic, assetId: rfq.assetId, sizeX: rfq.size }))
    }

    // (6) expire un-quoted RFQs and TTL'd quotes
    for (const [id, r] of [...pending]) {
      if (n - r.tick >= cfg.pendingTtlTicks) {
        pending.delete(id)
        events.push(emit({ type: 'rfq_expire', rfqId: id, assetId: r.assetId }))
      }
    }
    for (const q of quotes.expireDue(n)) {
      events.push(emit({ type: 'quote_expire', quoteId: q.id, rfqId: q.rfqId, assetId: q.assetId }))
      closeRfq(q.rfqId)
    }

    // (7) execution hazard, ascending quoteId
    const live = quotes.live().sort((a, b) => quoteNum(a.id) - quoteNum(b.id))
    for (const q of live) {
      const rfqObj = rfqs.get(q.rfqId)
      const entry = clientById(q.clientId) ?? { id: q.clientId, archetype: q.archetype, size: { medianX: q.size } }
      const client = resolveClient(entry, diff)
      const mid = price.mid(q.assetId)
      const sigmaM = price.sigmaM(q.assetId)
      const res = evaluateQuoteFill({ quote: q, mid, sigmaM, n, dt, rng, client, diff: diffHaz })
      if (!res) continue

      const fee = 0 // student is the maker on client fills
      pnl.onClientFill({ assetId: q.assetId, clientBuys: res.clientBuys, size: q.size, price: res.price, fee, meta: { quoteId: q.id, clientId: q.clientId } })
      quotes.markFilled(q.id, res, n)

      // toxic drift activates on fill (Q3)
      if (rfqObj?.isToxic) {
        const path = buildDriftPath(diff.toxic, sigmaM / mid)
        toxicDrift.activate({ assetId: q.assetId, path, startTick: n + 1, clientBuys: res.clientBuys })
      }
      const p = pnl.snapshot()
      events.push(emit({
        type: 'fill', quoteId: q.id, rfqId: q.rfqId, clientId: q.clientId, archetype: q.archetype, isToxic: !!rfqObj?.isToxic,
        assetId: q.assetId, side: res.side, sizeX: q.size, price: res.price, fairMid_at_event: mid, edge_sigma: res.edge,
        position_after: p.positions[q.assetId] ?? 0, cash_after: p.cash,
      }))
      closeRfq(q.rfqId)
    }

    n += 1
    if (n >= totalTicks) done = true
    return events
  }

  // ---- read APIs -------------------------------------------------------------
  function snapshotCash() {
    return pnl.snapshot().cash
  }
  function liveQuoteViews() {
    return quotes.live().map((q) => ({ id: q.id, rfqId: q.rfqId, assetId: q.assetId, clientId: q.clientId, bid: q.bid, ask: q.ask, size: q.size, ageTicks: n - q.createdTick, ttlTicks: q.ttlTicks, refreshCount: q.refreshCount }))
  }
  function getState() {
    const p = pnl.snapshot()
    let grossUsd = 0
    for (const id of assetIds) grossUsd += Math.abs((p.positions[id] ?? 0) * price.mid(id))
    return {
      tick: n,
      timeSec: n * dt,
      done,
      progress: totalTicks ? n / totalTicks : 0,
      positions: p.positions,
      usdDelta: p.usdDelta,
      grossUsd,
      overInventory: grossUsd > cfg.softInventoryUsd,
      cash: p.cash,
      equity: p.equity,
      totalPnL: p.totalPnL,
      decomposition: p.decomposition,
      liveQuotes: liveQuoteViews(),
      pendingRfqs: [...pending.values()].map((r) => ({ ...r, ageTicks: n - r.tick, pendingTtlTicks: cfg.pendingTtlTicks })),
      blotter: p.blotter,
    }
  }

  return {
    // mutation
    tick, submitQuote, cancelQuote, refreshQuote, hedge,
    // reads
    getState, getEventLog: () => log.slice(),
    getBookSnapshot: (venueId) => book.getBookSnapshot(venueId),
    venueIds: () => book.venueIds(),
    venuesForAsset: (assetId) => book.venuesForAsset(assetId),
    venueInfo: (venueId) => book.venueInfo(venueId),
    // meta
    assetIds: () => assetIds.slice(),
    difficulty: cfg.difficulty,
    gated,
    config: cfg,
    totalTicks,
    isDone: () => done,
  }
}

// Headless replay for benchmark bots / grading (Phase 3). `policy` is a pure
// (observableState) -> actions[] callback run each tick before advancing; the
// identical seed+config+policy reproduces the identical event log.
export function runFromSeed(seed, { difficulty = 'medium', tier = 'pro', config = {} } = {}, policy = null) {
  const s = createSession({ seed, difficulty, tier, config })
  while (!s.isDone()) {
    if (policy) {
      const actions = policy(s.getState(), s) || []
      for (const a of actions) applyAction(s, a)
    }
    s.tick()
  }
  return { eventLog: s.getEventLog(), finalState: s.getState() }
}

function applyAction(s, a) {
  switch (a.type) {
    case 'submitQuote': return s.submitQuote(a.rfqId, { bid: a.bid, ask: a.ask })
    case 'cancelQuote': return s.cancelQuote(a.rfqId)
    case 'refreshQuote': return s.refreshQuote(a.rfqId, { bid: a.bid, ask: a.ask })
    case 'hedge': return s.hedge(a)
    default: return null
  }
}
