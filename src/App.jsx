import { useEffect, useRef, useState } from 'react'
import { createRng } from '../engine/rng.js'
import { createPriceProcess } from '../engine/price.js'
import { createBook } from '../engine/book.js'
import { createClock } from '../engine/clock.js'
import { ASSETS, VENUES, DT, BOOK_RENDER_MS, LADDER_DEPTH, readSeed } from './simConfig.js'
import './App.css'

// M4 visual checkpoint: a breathing, GBM-driven L2 book. No RFQs yet — this is
// the first thing you watch move. Sim ticks at 250 ms; the ladder repaints at
// most once per BOOK_RENDER_MS (500 ms → every other tick).

const RENDER_EVERY = Math.max(1, Math.round(BOOK_RENDER_MS / (DT * 1000)))

export default function App() {
  const venue = VENUES[0]
  const [seed] = useState(readSeed)
  const [view, setView] = useState(null)
  const [running, setRunning] = useState(true)
  const clockRef = useRef(null)

  useEffect(() => {
    const rng = createRng(seed)
    const price = createPriceProcess({ rng, dt: DT, assets: ASSETS })
    const book = createBook({ rng, price, venues: VENUES })
    book.tick(0)

    let prevMid = book.mid(venue.id)
    const clock = createClock({
      dt: DT,
      onTick: (n) => {
        price.step(n)
        book.tick(n)
        if (n % RENDER_EVERY === 0) {
          const snap = book.getBookSnapshot(venue.id)
          const dir = snap.mid > prevMid ? 'up' : snap.mid < prevMid ? 'down' : 'flat'
          prevMid = snap.mid
          setView({ n, t: (n * DT).toFixed(1), snap, dir })
        }
      },
    })
    clockRef.current = clock
    clock.start()
    return () => clock.stop()
  }, [seed, venue.id])

  function toggle() {
    const clock = clockRef.current
    if (!clock) return
    if (clock.running()) {
      clock.stop()
      setRunning(false)
    } else {
      clock.start()
      setRunning(true)
    }
  }

  return (
    <div className="terminal">
      <header className="bar">
        <span className="title">OTC DESK · live book</span>
        <span className="meta">seed {seed}</span>
        <span className="meta">venue {venue.id}</span>
        <span className="meta">t {view ? view.t : '0.0'}s</span>
        <span className={`mid ${view ? view.dir : ''}`}>
          {view ? fmt(view.snap.mid) : '—'}
          <span className="arrow">{view && view.dir === 'up' ? ' ▲' : view && view.dir === 'down' ? ' ▼' : ''}</span>
        </span>
        <button className="ctl" onClick={toggle}>
          {running ? '⏸ pause' : '▶ run'}
        </button>
      </header>
      {view ? <Ladder snap={view.snap} dir={view.dir} /> : <div className="loading">booting…</div>}
      <footer className="bar foot">
        <span className="meta">tick {DT * 1000}ms</span>
        <span className="meta">repaint {BOOK_RENDER_MS}ms</span>
        <span className="meta">M4 — no RFQs yet</span>
      </footer>
    </div>
  )
}

const fmt = (x, d = 2) =>
  x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

// Accumulate size outward from the inside (best price) so each row's Total is
// the cumulative depth up to and including that level — Hyperliquid style.
function withCumulative(levels) {
  let cum = 0
  return levels.map((l) => {
    cum += l.size
    return { ...l, total: cum }
  })
}

function Ladder({ snap, dir }) {
  const askRows = withCumulative(snap.asks.slice(0, LADDER_DEPTH)) // best → worst
  const bidRows = withCumulative(snap.bids.slice(0, LADDER_DEPTH)) // best → worst
  const maxTotal = Math.max(
    askRows.length ? askRows[askRows.length - 1].total : 0,
    bidRows.length ? bidRows[bidRows.length - 1].total : 0,
    1e-9,
  )
  const spreadPct = (snap.spread / snap.mid) * 100

  return (
    <div className="book">
      <div className="cols">
        <span>Price</span>
        <span className="num">Size</span>
        <span className="num">Total</span>
      </div>
      {/* asks: worst at top, best (tightest) just above the spread row */}
      {askRows
        .slice()
        .reverse()
        .map((lvl, i) => (
          <Row key={`a${i}`} lvl={lvl} side="ask" maxTotal={maxTotal} />
        ))}
      <div className={`midrow ${dir}`}>
        <span className="lbl">Spread</span>
        <span className="num spreadabs">{fmt(snap.spread)}</span>
        <span className="num spreadpct">{spreadPct.toFixed(3)}%</span>
        <span className="midpx">
          {fmt(snap.mid)}
          <span className="arrow">{dir === 'up' ? ' ▲' : dir === 'down' ? ' ▼' : ''}</span>
        </span>
      </div>
      {/* bids: best (tightest) just below the spread row, worst at bottom */}
      {bidRows.map((lvl, i) => (
        <Row key={`b${i}`} lvl={lvl} side="bid" maxTotal={maxTotal} />
      ))}
    </div>
  )
}

function Row({ lvl, side, maxTotal }) {
  const pct = Math.max(1.5, (lvl.total / maxTotal) * 100)
  return (
    <div className={`row ${side}`}>
      <span className="depthbar" style={{ width: `${pct}%` }} />
      <span className="px">{fmt(lvl.price)}</span>
      <span className="num sz">{fmt(lvl.size)}</span>
      <span className="num tot">{fmt(lvl.total)}</span>
    </div>
  )
}
