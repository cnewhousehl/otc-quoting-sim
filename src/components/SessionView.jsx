import { useState } from 'react'
import { useSession } from '../sim/useSession.js'
import Ladder from './Ladder.jsx'
import { fmt, usd, usdCompact, signedUsd, px } from '../format.js'

export default function SessionView({ startConfig, onExit }) {
  const sim = useSession(startConfig)
  const [denom, setDenom] = useState('coin')
  const { state } = sim
  if (!state) return <div className="loading">booting session…</div>
  const assets = sim.session.current.assetIds()

  return (
    <div className="desk">
      <TopBar sim={sim} onExit={onExit} denom={denom} setDenom={setDenom} />
      <NewsBar state={state} />
      <div className="desk-body">
        <aside className="rfq-col">
          <RfqInbox sim={sim} denom={denom} />
        </aside>
        <aside className="manage-col">
          <Positions sim={sim} denom={denom} />
          <Pnl state={state} />
          <Trades state={state} denom={denom} />
        </aside>
        <main className="books-grid">
          {assets.map((a) => (
            <AssetBook key={a} sim={sim} asset={a} denom={denom} />
          ))}
        </main>
      </div>
    </div>
  )
}

function TopBar({ sim, onExit, denom, setDenom }) {
  const { state, running, togglePause, session } = sim
  return (
    <header className="bar">
      <span className="title">OTC DESK</span>
      <span className="meta">{session.current.difficulty}</span>
      <span className="meta">{session.current.config.scenario}</span>
      <span className="meta">t {Math.floor(state.timeSec)}s · {Math.round(state.progress * 100)}%</span>
      <span className="meta">equity {usd(state.equity)}</span>
      <span className={`meta pnl ${state.totalPnL >= 0 ? 'pos' : 'neg'}`}>{signedUsd(state.totalPnL)}</span>
      <span className="spacer" />
      <span className="denom">
        <button className={denom === 'coin' ? 'on' : ''} onClick={() => setDenom('coin')}>coin</button>
        <button className={denom === 'usd' ? 'on' : ''} onClick={() => setDenom('usd')}>$</button>
      </span>
      <button className="ctl" onClick={togglePause}>{running ? '⏸' : '▶'}</button>
      <button className="ctl" onClick={onExit}>exit</button>
    </header>
  )
}

function NewsBar({ state }) {
  const feed = state.news || []
  const next = Math.ceil(state.nextNewsSec ?? 0)
  return (
    <div className="newsbar">
      <div className="news-side">
        <span className="news-tag">NEWS</span>
        <span className="news-next">next {next}s</span>
      </div>
      <div className="news-feed">
        {feed.length === 0 && <span className="news-head dim">watching the wires…</span>}
        {feed.map((nv, i) => (
          <span key={i} className={`news-line ${nv.direction > 0 ? 'up' : 'down'} ${i === 0 ? 'latest' : ''}`}>
            {nv.direction > 0 ? '▲' : '▼'} {nv.headline}
            <em>{nv.magnitude}{nv.scope === 'asset' ? ` · ${nv.assets.join('/')}` : ' · macro'}</em>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- left: RFQ inbox + live quotes -----------------------------------------
function RfqInbox({ sim, denom }) {
  const { state } = sim
  return (
    <div className="panel fill">
      <div className="panel-h">RFQs <span className="badge">{state.pendingRfqs.length}</span></div>
      <div className="scroll">
        {state.pendingRfqs.length === 0 && <div className="empty">waiting for inbound…</div>}
        {state.pendingRfqs.map((r) => <RfqCard key={r.id} rfq={r} sim={sim} denom={denom} />)}
        <LiveQuotes sim={sim} />
      </div>
    </div>
  )
}

function RfqCard({ rfq, sim, denom }) {
  const venue = sim.venuesForAsset(rfq.assetId)[0]
  const mid = sim.getBook(venue)?.mid ?? rfq.refPrice
  const [w, setW] = useState(8)
  const [skew, setSkew] = useState(0)
  const pos = sim.state.positions[rfq.assetId] ?? 0
  const bid = mid * (1 + (skew - w) / 1e4)
  const ask = mid * (1 + (skew + w) / 1e4)
  const ttlPct = Math.max(0, 100 - (rfq.ageTicks / rfq.pendingTtlTicks) * 100)
  const showHedge = sim.session.current.difficulty !== 'hard'
  const hc = showHedge ? sim.session.current.estimateHedgeWidth(rfq.assetId, rfq.size) : null

  return (
    <div className="rfq">
      <div className="rfq-top">
        <span className="who">
          {rfq.handle}
          {rfq.biasShown && <span className={`bias ${rfq.biasLabel}`}>{rfq.biasLabel}</span>}
          {rfq.favorShown && rfq.favorLabel !== 'neutral' && <span className={`favor ${rfq.favorLabel}`}>{rfq.favorLabel === 'favored' ? '★ favored' : 'wary'}</span>}
        </span>
        <span className="amt">{usd(rfq.notional)}</span>
      </div>
      <div className="rfq-sub">
        <span>{rfq.assetId} · {denom === 'usd' ? usdCompact(rfq.notional) : `${fmt(rfq.size, 3)}`}</span>
        {hc && hc.bps != null && <span className="hedgehint">hedge ~{hc.bps.toFixed(0)}bps {hc.tier}</span>}
      </div>
      {pos !== 0 && <div className={`pos-hint ${pos > 0 ? 'long' : 'short'}`}>you {pos > 0 ? 'long' : 'short'} {fmt(Math.abs(pos), 2)} — skew to flatten</div>}
      <div className="quote-row">
        <span className="bid">{px(bid)}</span>
        <span className="x">/</span>
        <span className="ask">{px(ask)}</span>
      </div>
      <div className="sliders">
        <label>width {w}bps<input type="range" min="1" max="120" value={w} onChange={(e) => setW(+e.target.value)} /></label>
        <label>skew {skew}bps<input type="range" min="-50" max="50" value={skew} onChange={(e) => setSkew(+e.target.value)} /></label>
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
    <>
      <div className="sub-h">Live quotes</div>
      {state.liveQuotes.map((q) => {
        const ttlPct = Math.max(0, 100 - (q.ageTicks / q.ttlTicks) * 100)
        const v = sim.venuesForAsset(q.assetId)[0]
        const mid = sim.getBook(v)?.mid ?? (q.bid + q.ask) / 2
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
    </>
  )
}

// ---- middle: positions / pnl / trades --------------------------------------
function Positions({ sim, denom }) {
  const { state } = sim
  const all = sim.session.current.assetIds()
  return (
    <div className="panel">
      <div className="panel-h">Positions <span className={`badge ${state.overInventory ? 'warn' : ''}`}>{usd(state.usdDelta)} Δ</span></div>
      {all.every((a) => Math.abs(state.positions[a] ?? 0) < 1e-9) && <div className="empty">flat</div>}
      {all.map((a) => {
        const q = state.positions[a] ?? 0
        if (Math.abs(q) < 1e-9) return null
        const mid = sim.getBook(sim.venuesForAsset(a)[0])?.mid ?? 0
        return (
          <div key={a} className={`posrow ${q > 0 ? 'long' : 'short'}`}>
            <span className="pa">{a}</span>
            <span className="pq">{q > 0 ? '+' : '−'}{denom === 'usd' ? usdCompact(Math.abs(q * mid)) : fmt(Math.abs(q), 3)}</span>
          </div>
        )
      })}
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
        <div key={k} className="pnlrow"><span>{k}</span><span className={v >= 0 ? 'pos' : 'neg'}>{signedUsd(v)}</span></div>
      ))}
      <div className="pnlrow total"><span>Total</span><span className={state.totalPnL >= 0 ? 'pos' : 'neg'}>{signedUsd(state.totalPnL)}</span></div>
    </div>
  )
}

function Trades({ state, denom }) {
  const fills = (state.blotter || []).map((b) => ({ kind: 'fill', ...b }))
  const hedges = (state.hedgeLog || []).map((h) => ({ kind: 'hedge', ...h }))
  const tape = [...fills, ...hedges].slice(-40).reverse()
  return (
    <div className="panel fill">
      <div className="panel-h">Trades</div>
      <div className="scroll tape-v">
        {tape.length === 0 && <div className="empty">no prints yet</div>}
        {tape.map((t, i) => {
          const p = t.price ?? t.vwap
          return (
            <div key={i} className={`tprint ${t.side === 'buy' ? 'buy' : 'sell'}`}>
              <span>{t.kind === 'fill' ? '◆ client' : '⌁ hedge'}</span>
              <span>{t.assetId} {t.side} {denom === 'usd' ? usdCompact(t.size * p) : fmt(t.size, 2)}</span>
              <span className="tpx">{px(p)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- right: 2x2 asset books -------------------------------------------------
function AssetBook({ sim, asset, denom }) {
  const venues = sim.venuesForAsset(asset)
  const dir = sim.dirs[asset]
  const primary = venues[0]
  const mid = sim.getBook(primary)?.mid ?? 0
  const [size, setSize] = useState(0.5)
  const [hv, setHv] = useState(primary)
  const v = venues.includes(hv) ? hv : primary
  const pos = sim.state.positions[asset] ?? 0
  const sizeCoin = denom === 'usd' ? size / (mid || 1) : size

  return (
    <div className="abook">
      <div className="abook-h">
        <span className={`aname ${dir || ''}`}>{asset} {px(mid)} {dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</span>
        {Math.abs(pos) > 1e-9 && <span className={`apos ${pos > 0 ? 'long' : 'short'}`}>{pos > 0 ? '+' : '−'}{fmt(Math.abs(pos), 2)}</span>}
      </div>
      <div className="ladders">
        {venues.map((vid) => (
          <div key={vid} className="lwrap">
            <div className="ltier">{sim.venueInfo(vid).tier}</div>
            <Ladder snap={sim.getBook(vid)} dir={dir} denom={denom} compact depth={5} />
          </div>
        ))}
      </div>
      <div className="abook-hedge">
        <select value={v} onChange={(e) => setHv(e.target.value)}>
          {venues.map((x) => <option key={x} value={x}>{sim.venueInfo(x).tier}</option>)}
        </select>
        <input type="number" step="0.1" value={size} onChange={(e) => setSize(+e.target.value)} />
        <button className="buy" onClick={() => sim.hedge({ assetId: asset, venueId: v, side: 'buy', size: Math.abs(sizeCoin) })}>buy</button>
        <button className="sell" onClick={() => sim.hedge({ assetId: asset, venueId: v, side: 'sell', size: Math.abs(sizeCoin) })}>sell</button>
        {Math.abs(pos) > 1e-9 && (
          <button className="flat" onClick={() => sim.hedge({ assetId: asset, venueId: v, side: pos > 0 ? 'sell' : 'buy', size: Math.abs(pos) })}>flat</button>
        )}
      </div>
    </div>
  )
}
