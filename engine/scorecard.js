// engine/scorecard.js
//
// Post-trade scorecard (PLAN.md Phase-1 grading substrate). A PURE function over
// what the session already records — the event log, the sampled equity path, and
// the final P&L decomposition — so it's deterministic and replayable (same seed +
// policy ⇒ same scorecard).
//
// It turns a session into:
//   - headline metrics (P&L + decomposition, fill rate, time-to-quote, hedge
//     execution quality, adverse selection, franchise, inventory risk),
//   - a 0–100 score on each of six DIMENSIONS (rubric-based, so a solo run grades
//     without needing a benchmark opponent), and
//   - a primary TRADER ARCHETYPE: the dimension the desk leaned into hardest
//     ("most P/L", "quickest to quote", "best hedging", … — the categories asked
//     for), plus an overall letter grade.
//
// Each dimension carries a short teaching blurb so the report doubles as feedback.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
// map a raw value onto 0..100 with a soft floor/ceiling (lo→0, hi→100)
const score01 = (x, lo, hi) => clamp(((x - lo) / (hi - lo)) * 100, 0, 100)
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// ARCHETYPES — the dimension a desk is strongest on becomes its handle.
export const ARCHETYPES = {
  pnl: { key: 'pnl', label: 'P&L', title: 'The Edge Hunter', blurb: 'You maximized captured spread. Watch that the edge survives hedging and adverse selection — gross spread is not realized P&L.' },
  speed: { key: 'speed', label: 'Speed', title: 'The Sniper', blurb: 'You streamed prices fast. Quoting first wins flow, but a fast wrong price is how toxic names pick you off.' },
  hedging: { key: 'hedging', label: 'Hedging', title: 'The Risk Manager', blurb: 'You backed risk out cleanly and cheaply. The discipline costs a little edge but protects you when the mid runs.' },
  adverse: { key: 'adverse', label: 'Adverse selection', title: 'The Sharp Reader', blurb: 'You avoided the winner’s curse — widening or passing on informed flow. The hardest skill on the desk.' },
  franchise: { key: 'franchise', label: 'Franchise', title: 'The Relationship Banker', blurb: 'You kept clients happy and flow coming. A strong franchise is the moat; just don’t subsidize toxic names to keep it.' },
  risk: { key: 'risk', label: 'Risk-adjusted', title: 'The Steady Hand', blurb: 'You made money without big inventory swings. Smooth equity is what lets a desk size up.' },
}

// Build the scorecard. `dt` comes from the session config.
export function buildScorecard({ eventLog = [], equitySamples = [], finalState = {}, dt = 0.25 } = {}) {
  const by = (t) => eventLog.filter((e) => e.type === t)
  const rfqNew = by('rfq_new')
  const quoteSubmit = by('quote_submit')
  const fills = by('fill')
  const hedges = by('hedge')
  const limitFills = by('limit_fill')
  const passes = by('rfq_pass')
  const expires = by('rfq_expire')

  // ---- time-to-quote: first quote per RFQ minus its arrival -----------------
  const arrivalTick = new Map(rfqNew.map((e) => [e.rfqId, e.tick]))
  const firstQuoteTick = new Map()
  for (const q of quoteSubmit) {
    if (!firstQuoteTick.has(q.rfqId)) firstQuoteTick.set(q.rfqId, q.tick)
  }
  const ttqSec = []
  for (const [rfqId, qt] of firstQuoteTick) {
    const at = arrivalTick.get(rfqId)
    if (at != null) ttqSec.push((qt - at) * dt)
  }

  // ---- fills / flow ----------------------------------------------------------
  const rfqsSeen = rfqNew.length
  const quotesSent = firstQuoteTick.size
  const fillsWon = fills.length
  const toxicFills = fills.filter((f) => f.isToxic)
  const fillRate = quotesSent ? fillsWon / quotesSent : 0
  const quoteRate = rfqsSeen ? quotesSent / rfqsSeen : 0

  // ---- hedge execution quality ----------------------------------------------
  // slippage in bps of the fair mid at the time of each hedge (lower is better).
  const hedgeSlipBps = hedges
    .filter((h) => h.sizeX > 0 && h.fairMid_at_event > 0)
    .map((h) => Math.abs(h.hedgeSlippage / (h.sizeX * h.fairMid_at_event)) * 1e4)
  const avgHedgeSlipBps = mean(hedgeSlipBps)
  const hedgedNotional = hedges.reduce((a, h) => a + h.sizeX * (h.fairMid_at_event || 0), 0) + limitFills.reduce((a, l) => a + l.sizeX * (l.price || 0), 0)
  const filledNotional = fills.reduce((a, f) => a + f.sizeX * (f.fairMid_at_event || f.price || 0), 0)
  const hedgeRatio = filledNotional ? clamp(hedgedNotional / filledNotional, 0, 1.5) : 0

  // ---- inventory risk path (drawdown + Sortino-style) ------------------------
  const peakGrossUsd = equitySamples.reduce((m, s) => Math.max(m, s.grossUsd), 0)
  const pnlPath = equitySamples.map((s) => s.totalPnL)
  let maxDrawdown = 0
  let peak = -Infinity
  for (const v of pnlPath) {
    peak = Math.max(peak, v)
    maxDrawdown = Math.max(maxDrawdown, peak - v)
  }
  // increments of P&L; downside deviation only (Sortino numerator = total return)
  const incr = pnlPath.slice(1).map((v, i) => v - pnlPath[i])
  const downside = incr.filter((x) => x < 0)
  const downDev = Math.sqrt(mean(downside.map((x) => x * x))) || 0
  const totalPnL = finalState.totalPnL ?? (pnlPath.length ? pnlPath[pnlPath.length - 1] : 0)
  const sortino = downDev > 0 ? totalPnL / (downDev * Math.sqrt(incr.length || 1)) : totalPnL > 0 ? 3 : 0

  // ---- franchise -------------------------------------------------------------
  const passRate = rfqsSeen ? passes.length / rfqsSeen : 0
  const expireRate = rfqsSeen ? expires.length / rfqsSeen : 0
  // engaged = quoted or consciously passed; ghosting RFQs (letting them expire) hurts
  const engagement = clamp(quoteRate + 0.3 * passRate - expireRate, 0, 1)

  const decomp = finalState.decomposition ?? { grossSpread: 0, advSel: 0, hedgeSlippage: 0, fees: 0, invMtM: 0 }
  const grossSpread = decomp.grossSpread ?? 0
  const advSel = decomp.advSel ?? 0 // negative = picked off

  // ---- per-dimension 0..100 scores (rubric) ---------------------------------
  // Scale P&L/adverse to TRADED NOTIONAL — a desk is judged on edge captured per
  // unit of flow, not an absolute $ target (clips here are million-notional). The
  // "great" mark is ~10 bps of flow; "disaster" is losing that much.
  const pnlScale = Math.max(25_000, 0.001 * filledNotional)
  // Hedging rewards actually backing risk out (hedgeRatio dominant) AND doing it
  // cheaply (exec quality) — but exec quality only counts when you hedged, so a
  // warehouse that never hedges scores low rather than getting a free pass.
  const execQuality = hedgeSlipBps.length ? 100 - score01(avgHedgeSlipBps, 2, 50) : 0
  const dims = {
    pnl: score01(totalPnL, -pnlScale, pnlScale),
    speed: ttqSec.length ? 100 - score01(median(ttqSec), 1, 20) : 0, // <1s ⇒ ~100, >20s ⇒ 0; never quoting ⇒ 0
    hedging: clamp(0.6 * clamp(hedgeRatio, 0, 1) * 100 + 0.4 * execQuality, 0, 100),
    adverse: score01(advSel, -pnlScale * 0.6, 0), // 0 picked-off ⇒ 100, losing 0.6·scale ⇒ 0
    franchise: clamp(0.6 * engagement * 100 + 0.4 * (100 - score01(passRate, 0.05, 0.5)), 0, 100),
    risk: score01(sortino, -1, 3),
  }

  // primary archetype = highest dimension (ties: P&L > hedging > adverse > … )
  const order = ['pnl', 'hedging', 'adverse', 'risk', 'speed', 'franchise']
  let best = order[0]
  for (const k of order) if (dims[k] > dims[best] + 1e-9) best = k
  // Overall weights outcome dimensions (P&L, risk, hedging, adverse) over process
  // ones (speed, franchise), so a blow-up can't grade well on hustle alone.
  const W = { pnl: 2.5, risk: 1.5, hedging: 1.5, adverse: 1.5, speed: 1, franchise: 1 }
  const wSum = Object.values(W).reduce((a, b) => a + b, 0)
  const overall = order.reduce((a, k) => a + dims[k] * W[k], 0) / wSum
  const grade = overall >= 85 ? 'A' : overall >= 70 ? 'B' : overall >= 55 ? 'C' : overall >= 40 ? 'D' : 'F'

  return {
    archetype: ARCHETYPES[best],
    grade,
    overall: Math.round(overall),
    dimensions: order.map((k) => ({ ...ARCHETYPES[k], score: Math.round(dims[k]) })),
    pnl: { total: totalPnL, decomposition: decomp },
    metrics: {
      rfqsSeen, quotesSent, fillsWon, fillRate, quoteRate, passes: passes.length, expired: expires.length,
      toxicFillsWon: toxicFills.length, toxicFillRate: fillsWon ? toxicFills.length / fillsWon : 0,
      medianTimeToQuoteSec: median(ttqSec), avgTimeToQuoteSec: mean(ttqSec), fastestQuoteSec: ttqSec.length ? Math.min(...ttqSec) : 0,
      hedgeCount: hedges.length, avgHedgeSlipBps, hedgeRatio,
      grossSpread, adverseSelectionUsd: advSel, hedgeSlippageUsd: decomp.hedgeSlippage ?? 0, feesUsd: decomp.fees ?? 0,
      peakGrossUsd, maxDrawdownUsd: maxDrawdown, sortino,
    },
  }
}
