import { useState } from 'react'
import { useSession } from '../sim/useSession.js'
import Ladder from './Ladder.jsx'
import { fmt, usd, signedUsd, px } from '../format.js'

export default function SessionView({ startConfig, onExit }) {
  const sim = useSession(startConfig)
  const { state, dirs, activeAsset, setActiveAsset } = sim
  if (!state) return <div className="loading">booting session…</div>

  const assets = sim.session.current.assetIds()

  return (
    <div className="terminal-wide">
      <TopBar sim={sim} onExit={onExit} />
      <NewsBar state={state} />
      <div className="layout">
        <aside className="col rfqs">
          <RfqInbox sim={sim} />
          <LiveQuotes sim={sim} />
        </aside>

        <main className="col books">
          <div className="asset-tabs">
            {assets.map((a) => (
              <button key={a} className={`atab ${a === activeAsset ? 'on' : ''} ${dirs[a] || ''}`} onClick={() => setActiveAsset(a)}>
                {a}
              </button>
            ))}
          </div>
          <BooksForAsset sim={sim} asset={activeAsset} />
        </main>

        <aside className="col side">
          <Positions sim={sim} />
          <Pnl state={state} />
          <HedgePanel sim={sim} />
        </aside>
      </div>
      <TradesTape state={state} />
    </div>
  )
}

function TopBar({ sim, onExit }) {
  const { state, running, togglePause, session } = sim
  const pct = Math.round(state.progress * 100)
  return (
    <header className="bar">
      <span className="title">OTC DESK</span>
      <span className="meta">{session.current.difficulty}</span>
      <span className="meta">{session.current.config.scenario}</span>
      <span className="meta">t {Math.floor(state.timeSec)}s · {pct}%</span>
      <span className="meta">equity {usd(state.equity)}</span>
      <span className={`meta pnl ${state.totalPnL >= 0 ? 'pos' : 'neg'}`}>{signedUsd(state.totalPnL)}</span>
      <button className="ctl" onClick={togglePause}>{running ? '⏸' : '▶'}</button>
      <button className="ctl" onClick={onExit}>exit</button>
    </header>
  )
}

function NewsBar({ state }) {
  const latest = state.news && state.news[0]
  const next = Math.ceil(state.nextNewsSec ?? 0)
  return (
    <div className="newsbar">
      <span className="news-tag">NEWS</span>
      {latest ? (
        <span className={`news-head ${latest.direction > 0 ? 'up' : 'down'}`}>
          {latest.direction > 0 ? '▲' : '▼'} {latest.headline}
          <em>{latest.magnitude}{latest.scope === 'asset' ? ` · ${latest.assets.join('/')}` : ' · macro'}</em>
        </span>
      ) : (
        <span className="news-head dim">watching the wires…</span>
      )}
      <span className="news-next">next in {next}s</span>
    </div>
  )
}

function BooksForAsset({ sim, asset }) {
  const venues = sim.venuesForAsset(asset)
  const [vid, setVid] = useState(venues[0])
  const active = venues.includes(vid) ? vid : venues[0]
  const snap = sim.getBook(active)
  const info = sim.venueInfo(active)
  return (
    <div>
      <div className="venue-tabs">
        {venues.map((v) => {
          const s = sim.getBook(v)
          const inf = sim.venueInfo(v)
          return (
            <button key={v} className={`vtab ${v === active ? 'on' : ''}`} onClick={() => setVid(v)}>
              <span>{inf.tier}</span>
              <small>{s ? `${((s.spread / s.mid) * 1e4).toFixed(1)}bps` : ''}</small>
            </button>
          )
        })}
      </div>
      <div className="venue-label">{active} · {info.type === 'amm' ? 'DEX AMM' : 'perp'}</div>
      <Ladder snap={snap} dir={sim.dirs[asset]} />
    </div>
  )
}

function RfqInbox({ sim }) {
  const { state } = sim
  return (
    <div className="panel">
      <div className="panel-h">RFQs <span className="badge">{state.pendingRfqs.length}</span></div>
      {state.pendingRfqs.length === 0 && <div className="empty">waiting for inbound…</div>}
      {state.pendingRfqs.map((r) => <RfqCard key={r.id} rfq={r} sim={sim} />)}
    </div>
  )
}

function RfqCard({ rfq, sim }) {
  const venue = sim.venuesForAsset(rfq.assetId)[0]
  const mid = sim.getBook(venue)?.mid ?? rfq.refPrice
  const [w, setW] = useState(8) // half-width, bps
  const [skew, setSkew] = useState(0) // signed skew, bps (lean to manage inventory)
  const pos = sim.state.positions[rfq.assetId] ?? 0
  const bid = mid * (1 + (skew - w) / 1e4)
  const ask = mid * (1 + (skew + w) / 1e4)
  const ttlPct = Math.max(0, 100 - (rfq.ageTicks / rfq.pendingTtlTicks) * 100)

  return (
    <div className="rfq">
      <div className="rfq-top">
        <span className="who">{rfq.handle}</span>
        <span className="amt">{usd(rfq.notional)} {rfq.assetId}</span>
      </div>
      <div className="rfq-sub">
        two-way · size {fmt(rfq.size, 3)}
        {pos !== 0 && <span className={`pos-hint ${pos > 0 ? 'long' : 'short'}`}>you {pos > 0 ? 'long' : 'short'} {fmt(Math.abs(pos), 2)}</span>}
      </div>
      <div className="quote-row">
        <span className="bid">{px(bid)}</span>
        <span className="x">/</span>
        <span className="ask">{px(ask)}</span>
      </div>
      <div className="sliders">
        <label>width {w}bps<input type="range" min="1" max="40" value={w} onChange={(e) => setW(+e.target.value)} /></label>
        <label>skew {skew}bps<input type="range" min="-25" max="25" value={skew} onChange={(e) => setSkew(+e.target.value)} /></label>
      </div>
      <button className="send" onClick={() => sim.submitQuote(rfq.id, { bid, ask })}>stream quote</button>
      <div className="ttl"><span style={{ width: `${ttlPct}%` }} /></div>
    </div>
  )
}

function LiveQuotes({ sim }) {
  const { state } = sim
  if (!state.liveQuotes.length) return null
  return (
    <div className="panel">
      <div className="panel-h">Live quotes</div>
      {state.liveQuotes.map((q) => {
        const ttlPct = Math.max(0, 100 - (q.ageTicks / q.ttlTicks) * 100)
        const mid = (() => {
          const v = sim.venuesForAsset(q.assetId)[0]
          return sim.getBook(v)?.mid ?? (q.bid + q.ask) / 2
        })()
        const w = (q.ask - q.bid) / 2
        return (
          <div key={q.id} className="liveq">
            <div className="rfq-top"><span className="who">{q.assetId}</span><span className="amt">{px(q.bid)} / {px(q.ask)}</span></div>
            <div className="ttl"><span style={{ width: `${ttlPct}%` }} /></div>
            <div className="lq-actions">
              <button onClick={() => sim.refreshQuote(q.rfqId, { bid: mid - w, ask: mid + w })}>refresh</button>
              <button className="off" onClick={() => sim.cancelQuote(q.rfqId)}>off</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Positions({ sim }) {
  const { state } = sim
  const entries = Object.entries(state.positions).filter(([, q]) => Math.abs(q) > 1e-9)
  return (
    <div className="panel">
      <div className="panel-h">Positions <span className={`badge ${state.overInventory ? 'warn' : ''}`}>{usd(state.usdDelta)} Δ</span></div>
      {entries.length === 0 && <div className="empty">flat</div>}
      {entries.map(([a, q]) => (
        <div key={a} className={`posrow ${q > 0 ? 'long' : 'short'}`}>
          <span className="pa">{a}</span>
          <span className="pq">{q > 0 ? '+' : '−'}{fmt(Math.abs(q), 3)}</span>
        </div>
      ))}
      {state.overInventory && <div className="inv-warn">⚠ over soft inventory limit</div>}
    </div>
  )
}

function Pnl({ state }) {
  const d = state.decomposition
  const rows = [
    ['Gross spread', d.grossSpread],
    ['Inventory MtM', d.invMtM],
    ['Adverse sel.', d.advSel],
    ['Hedge slippage', -d.hedgeSlippage],
    ['Fees', -d.fees],
  ]
  return (
    <div className="panel">
      <div className="panel-h">P&amp;L</div>
      {rows.map(([k, v]) => (
        <div key={k} className="pnlrow">
          <span>{k}</span>
          <span className={v >= 0 ? 'pos' : 'neg'}>{signedUsd(v)}</span>
        </div>
      ))}
      <div className="pnlrow total">
        <span>Total</span>
        <span className={state.totalPnL >= 0 ? 'pos' : 'neg'}>{signedUsd(state.totalPnL)}</span>
      </div>
    </div>
  )
}

function HedgePanel({ sim }) {
  const { state, activeAsset } = sim
  const venues = sim.venuesForAsset(activeAsset)
  const [vid, setVid] = useState(venues[0])
  const [size, setSize] = useState(0.5)
  const pos = state.positions[activeAsset] ?? 0
  const v = venues.includes(vid) ? vid : venues[0]
  return (
    <div className="panel">
      <div className="panel-h">Hedge {activeAsset}</div>
      <select value={v} onChange={(e) => setVid(e.target.value)}>
        {venues.map((x) => <option key={x} value={x}>{sim.venueInfo(x).tier} · {x.split(':')[0]}</option>)}
      </select>
      <input className="size-in" type="number" step="0.1" value={size} onChange={(e) => setSize(+e.target.value)} />
      <div className="hedge-btns">
        <button className="buy" onClick={() => sim.hedge({ assetId: activeAsset, venueId: v, side: 'buy', size: Math.abs(size) })}>buy</button>
        <button className="sell" onClick={() => sim.hedge({ assetId: activeAsset, venueId: v, side: 'sell', size: Math.abs(size) })}>sell</button>
      </div>
      {Math.abs(pos) > 1e-9 && (
        <button className="flat" onClick={() => sim.hedge({ assetId: activeAsset, venueId: v, side: pos > 0 ? 'sell' : 'buy', size: Math.abs(pos) })}>
          flatten ({pos > 0 ? 'sell' : 'buy'} {fmt(Math.abs(pos), 3)})
        </button>
      )}
    </div>
  )
}

function TradesTape({ state }) {
  const fills = (state.blotter || []).map((b) => ({ kind: 'fill', ...b }))
  const hedges = (state.hedgeLog || []).map((h) => ({ kind: 'hedge', ...h }))
  const tape = [...fills, ...hedges].slice(-14).reverse()
  return (
    <footer className="tape">
      <span className="tape-h">Trades</span>
      {tape.length === 0 && <span className="empty">no prints yet</span>}
      {tape.map((t, i) => (
        <span key={i} className={`print ${t.side === 'buy' ? 'buy' : 'sell'}`}>
          {t.kind === 'fill' ? '◆' : '⌁'} {t.assetId} {t.side} {fmt(t.size, 2)} @ {px(t.price ?? t.vwap)}
        </span>
      ))}
    </footer>
  )
}
