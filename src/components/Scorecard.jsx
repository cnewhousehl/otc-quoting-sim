import { usd, usdCompact, signedUsd } from '../format.js'

// Post-trade scorecard overlay (engine/scorecard.js). Shows the desk's trader
// archetype + grade, the P&L decomposition, a 0–100 bar per dimension, and the
// headline metrics — the end-of-session report card.
export default function Scorecard({ card, onExit, onReview }) {
  const { archetype, grade, overall, dimensions, pnl, metrics: m } = card
  return (
    <div className="card-overlay">
      <div className="scorecard">
        <header className="card-head">
          <div className="card-arch">
            <div className="card-arch-label">your desk played like</div>
            <h1>{archetype.title}</h1>
            <div className="card-arch-tag">strongest dimension · {archetype.label}</div>
          </div>
          <div className={`card-grade g-${grade}`}>
            <div className="grade-letter">{grade}</div>
            <div className="grade-score">{overall}/100</div>
          </div>
        </header>

        <p className="card-blurb">{archetype.blurb}</p>

        <section className="card-pnl">
          <div className={`card-pnl-total ${pnl.total >= 0 ? 'pos' : 'neg'}`}>
            <span className="lbl">session P&L</span>
            <span className="val">{signedUsd(pnl.total)}</span>
          </div>
          <Decomp d={pnl.decomposition} />
        </section>

        <section className="card-dims">
          {dimensions.map((d) => (
            <div className="dim-row" key={d.key}>
              <span className="dim-label" title={d.blurb}>{d.label}</span>
              <span className="dim-bar"><i style={{ width: `${d.score}%` }} className={barClass(d.score)} /></span>
              <span className="dim-score">{d.score}</span>
            </div>
          ))}
        </section>

        <section className="card-metrics">
          <Metric label="RFQs seen" value={m.rfqsSeen} />
          <Metric label="quoted / filled" value={`${m.quotesSent} / ${m.fillsWon}`} />
          <Metric label="fill rate" value={pct(m.fillRate)} />
          <Metric label="median time-to-quote" value={`${m.medianTimeToQuoteSec.toFixed(1)}s`} />
          <Metric label="hedges" value={m.hedgeCount} />
          <Metric label="avg hedge slip" value={`${m.avgHedgeSlipBps.toFixed(1)} bps`} />
          <Metric label="hedge ratio" value={pct(m.hedgeRatio)} hint="notional hedged ÷ filled" />
          <Metric label="toxic fills won" value={`${m.toxicFillsWon} (${pct(m.toxicFillRate)})`} bad={m.toxicFillRate > 0.4} />
          <Metric label="adverse selection" value={signedUsd(m.adverseSelectionUsd)} bad={m.adverseSelectionUsd < 0} />
          <Metric label="peak gross inventory" value={usdCompact(m.peakGrossUsd)} />
          <Metric label="max drawdown" value={usd(m.maxDrawdownUsd)} />
          <Metric label="risk-adj (Sortino)" value={m.sortino.toFixed(2)} />
        </section>

        <footer className="card-foot">
          <button className="ctl" onClick={onReview}>review desk</button>
          <button className="ctl primary" onClick={onExit}>new session</button>
        </footer>
      </div>
    </div>
  )
}

function Decomp({ d }) {
  const parts = [
    { k: 'gross spread', v: d.grossSpread, pos: true },
    { k: 'inventory MtM', v: d.invMtM },
    { k: 'adverse sel.', v: d.advSel },
    { k: 'hedge slippage', v: -(d.hedgeSlippage ?? 0) },
    { k: 'fees', v: -(d.fees ?? 0) },
  ]
  return (
    <div className="card-decomp">
      {parts.map((p) => (
        <div className="decomp-item" key={p.k}>
          <span className="dk">{p.k}</span>
          <span className={`dv ${p.v >= 0 ? 'pos' : 'neg'}`}>{signedUsd(p.v)}</span>
        </div>
      ))}
    </div>
  )
}

function Metric({ label, value, hint, bad }) {
  return (
    <div className="card-metric" title={hint}>
      <span className="m-label">{label}</span>
      <span className={`m-value ${bad ? 'neg' : ''}`}>{value}</span>
    </div>
  )
}

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`
const barClass = (s) => (s >= 70 ? 'good' : s >= 45 ? 'mid' : 'low')
