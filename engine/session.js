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

import { createRng, STREAMS } from './rng.js'
import { createPriceProcess } from './price.js'
import { createBook } from './book.js'
import { createPnL } from './pnl.js'
import { createQuoteBook } from './quote.js'
import { evaluateQuoteFill } from './fill.js'
import { resolveClient, buildDriftPath, createToxicDrift } from './client.js'
import { createRfqGenerator } from './rfq.js'
import { createNewsEngine, mergeInjections } from './news.js'
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
  if (cfg.bookUpdateSec == null) cfg.bookUpdateSec = diff.bookUpdateSec // difficulty default unless overridden
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
  const news = createNewsEngine({ rng, dt, assetIds: price.assetIds(), intervalMin: cfg.newsIntervalMin })
  const recentNews = []

  const assetIds = price.assetIds()
  for (const id of assetIds) pnl.setMark(id, price.mid(id))
  book.tick(0)

  // Market sentiment per asset: news pushes it, then it fades. Drives client
  // directional bias (willingness to cross the spread / informed conviction).
  const sentiment = {}
  for (const id of assetIds) sentiment[id] = 0
  const SENT_DECAY = Math.exp(-dt / 90) // news bias fades over ~1.5 min
  const MAG_W = { small: 0.3, medium: 0.6, large: 1.0 }

  function assignBias(rfq) {
    const sent = sentiment[rfq.assetId] ?? 0
    const z = rng.normal(STREAMS.rfqSpec, rfq.tick, rfq.id, 6)
    // Sharp clients carry informed conviction (predicts the drift); retail herds
    // on sentiment with more noise.
    const bias = rfq.archetype === 'sharp' ? Math.tanh(1.6 * z + 0.8 * sent) : Math.tanh(1.2 * sent + 0.7 * z)
    rfq.bias = bias
    rfq.biasLabel = bias > 0.2 ? 'bullish' : bias < -0.2 ? 'bearish' : 'neutral'
    rfq.biasShown = diff.transparency === 'full' // revealed on Easy
  }

  const totalTicks = Math.round((cfg.sessionMinutes * 60) / dt)
  let n = 0
  let done = false
  const log = []
  const rfqs = new Map() // rfqId -> rfq (all)
  const pending = new Map() // rfqId -> rfq awaiting a quote (counts toward cap)
  const quoteByRfq = new Map() // rfqId -> quoteId
  const restingLimits = [] // passive hedge limit orders awaiting the market
  let limitSeq = 0
  const favor = new Map() // clientId -> relationship favor in [0,1] (0.5 = neutral)
  const getFavor = (id) => favor.get(id) ?? 0.5

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

  // Passive/limit hedge: rests until the venue mid reaches it, then fills at the
  // limit price with NO slippage (you provided liquidity). May never fill — the
  // save-the-spread-vs-miss-the-hedge tradeoff. Great for pre-arming an options
  // hedge so a fill leaves you immediately flat.
  function placeLimitHedge({ assetId, venueId, side, size, price }) {
    const id = `lim${++limitSeq}`
    restingLimits.push({ id, assetId, venueId, side, size, price })
    emit({ type: 'limit_place', limitId: id, assetId, venueId, side, sizeX: size, price })
    return id
  }
  function cancelLimitHedge(id) {
    const i = restingLimits.findIndex((l) => l.id === id)
    if (i >= 0) {
      restingLimits.splice(i, 1)
      emit({ type: 'limit_cancel', limitId: id })
    }
  }

  // ---- the tick --------------------------------------------------------------
  function tick() {
    if (done) return []
    const events = []

    // (2-3) advance true mid with active toxic drift + news drift + GBM + jumps
    const midBefore = {}
    for (const id of assetIds) midBefore[id] = price.mid(id)
    price.step(n, mergeInjections(toxicDrift.injectionAt(n), news.injectionAt(n)))

    // (4) books + resilience/toxicity decay
    book.tick(n)

    // (8a) inventory mark-to-market from this tick's mid move (split GBM vs tox)
    const attr = {}
    for (const id of assetIds) {
      const c = price.components(id)
      attr[id] = { midBefore: midBefore[id], midAfter: price.mid(id), rGBM: c.rGBM }
    }
    pnl.onTick(attr)

    // (4b) passive limit hedges fill when the venue mid reaches them (no slippage)
    for (const lim of [...restingLimits]) {
      const m = book.mid(lim.venueId)
      const hit = lim.side === 'buy' ? m <= lim.price : m >= lim.price
      if (hit) {
        pnl.onHedge({ assetId: lim.assetId, buy: lim.side === 'buy', size: lim.size, vwap: lim.price, fee: 0, meta: { venueId: lim.venueId, limit: true } })
        const idx = restingLimits.indexOf(lim)
        if (idx >= 0) restingLimits.splice(idx, 1)
        events.push(emit({ type: 'limit_fill', assetId: lim.assetId, venueId: lim.venueId, side: lim.side, sizeX: lim.size, price: lim.price }))
      }
    }

    // sentiment fades each tick; relationship favor pulls back toward neutral
    for (const id of assetIds) sentiment[id] *= SENT_DECAY
    for (const [k, v] of favor) favor.set(k, v + (0.5 - v) * (diff.favorDecay ?? 0.004))

    // (5a) news catalyst — pivots the true mid and shifts sentiment
    const newsEv = news.step(n)
    if (newsEv) {
      recentNews.unshift(newsEv)
      if (recentNews.length > 8) recentNews.pop()
      const dw = newsEv.direction * MAG_W[newsEv.magnitude]
      for (const a of newsEv.assets) sentiment[a] = Math.max(-1.5, Math.min(1.5, (sentiment[a] ?? 0) + dw))
      events.push(emit({ type: 'news', catId: newsEv.catId, headline: newsEv.headline, scope: newsEv.scope, assets: newsEv.assets, direction: newsEv.direction, magnitude: newsEv.magnitude }))
    }

    // (5) create an RFQ (toxicity + bias pre-sampled at creation)
    const rfq = rfqGen.step(n, pending.size)
    if (rfq) {
      assignBias(rfq)
      const fv = getFavor(rfq.clientId)
      rfq.favor = fv
      rfq.favorLabel = fv > 0.65 ? 'favored' : fv < 0.35 ? 'wary' : 'neutral'
      rfq.favorShown = diff.transparency === 'full' // revealed on Easy
      rfqs.set(rfq.id, rfq)
      pending.set(rfq.id, rfq)
      events.push(emit({ type: 'rfq_new', rfqId: rfq.id, clientId: rfq.clientId, handle: rfq.handle, archetype: rfq.archetype, isToxic: rfq.isToxic, assetId: rfq.assetId, sizeX: rfq.size, bias: rfq.biasShown ? rfq.biasLabel : null }))
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
      client.bias = rfqObj?.bias ?? 0 // directional willingness to cross
      const mid = price.mid(q.assetId)
      // Reservation is anchored to the LIVE cost to hedge this clip (size vs
      // venue liquidity), so the winning width tracks the book, not a memorizable
      // constant. Cached per quote and refreshed every few ticks (books only
      // move on their cadence anyway). Relationship favor widens the buffer.
      if (q._hwTick == null || n - q._hwTick >= 4) {
        q._hwBps = estimateHedgeWidth(q.assetId, q.size)?.bps ?? 0
        q._hwTick = n
      }
      client.hedgeWidth = mid * (q._hwBps / 1e4)
      client.favorBonus = client.relStrength * (getFavor(q.clientId) - 0.5)
      const sigmaM = price.sigmaM(q.assetId)
      const res = evaluateQuoteFill({ quote: q, mid, sigmaM, n, dt, rng, client, diff: diffHaz })
      if (!res) continue

      const fee = 0 // student is the maker on client fills
      pnl.onClientFill({ assetId: q.assetId, clientBuys: res.clientBuys, size: q.size, price: res.price, fee, meta: { quoteId: q.id, clientId: q.clientId } })
      quotes.markFilled(q.id, res, n)

      // Relationship: a tight fill (good price for them) builds favor; taking a
      // wide one-off burns it — so high-favor clients accept the occasional wide
      // quote, then turn demanding again until you rebuild trust.
      const wFill = res.side === 'ask' ? q.ask - mid : mid - q.bid
      const buf = mid * (client.fill.bufferBps / 1e4) * (1 + (client.favorBonus ?? 0))
      const resWidth = client.hedgeWidth + buf
      let fv = getFavor(q.clientId)
      if (wFill <= client.hedgeWidth * 1.3) fv += 0.06 // tight → builds favor
      else if (wFill > resWidth * 0.75) fv -= 0.25 // wide one-off → burns favor
      favor.set(q.clientId, Math.max(0, Math.min(1, fv)))

      // toxic drift activates on fill (Q3); for informed flow the drift follows
      // the client's BIAS (their view), so you can pre-position against it.
      if (rfqObj?.isToxic) {
        const path = buildDriftPath(diff.toxic, sigmaM / mid)
        const sign = rfqObj.bias ? Math.sign(rfqObj.bias) : res.clientBuys ? 1 : -1
        toxicDrift.activate({ assetId: q.assetId, path, startTick: n + 1, sign })
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
  // Cheapest cost (bps vs mid) to hedge `size` of an asset across its venues —
  // shown on RFQs (Easy/Medium) so students can price relative to hedgability.
  function estimateHedgeWidth(assetId, size) {
    let best = null
    for (const vid of book.venuesForAsset(assetId)) {
      const est = book.estimateCost(vid, 'buy', size)
      if (best == null || est.slipBps < best.bps) best = { bps: est.slipBps, venueId: vid, tier: book.venueInfo(vid).tier, partial: est.partial }
    }
    return best
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
      hedgeLog: p.hedgeLog,
      news: recentNews.slice(0, 5),
      nextNewsSec: news.ticksToNext(n) * dt,
      sentiment: { ...sentiment },
      restingLimits: restingLimits.slice(),
    }
  }

  return {
    // mutation
    tick, submitQuote, cancelQuote, refreshQuote, hedge, placeLimitHedge, cancelLimitHedge,
    // reads
    getState, getEventLog: () => log.slice(),
    getBookSnapshot: (venueId) => book.getBookSnapshot(venueId),
    estimateHedgeWidth,
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
    case 'placeLimitHedge': return s.placeLimitHedge(a)
    case 'cancelLimitHedge': return s.cancelLimitHedge(a.limitId)
    default: return null
  }
}
