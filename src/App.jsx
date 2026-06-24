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
        <button className="ctl" onClick={toggle}>
          {running ? '⏸ pause' : '▶ run'}
        </button>
      </header>
      {view ? (
        <Ladder snap={view.snap} dir={view.dir} venue={venue} />
      ) : (
        <div className="loading">booting…</div>
      )}
      <footer className="bar foot">
        <span className="meta">tick {DT * 1000}ms</span>
        <span className="meta">repaint {BOOK_RENDER_MS}ms</span>
        <span className="meta">M4 — no RFQs yet</span>
      </footer>
    </div>
  )
}

function Ladder({ snap, dir, venue }) {
  const asks = snap.asks.slice(0, LADDER_DEPTH)
  const bids = snap.bids.slice(0, LADDER_DEPTH)
  const maxSize = Math.max(...asks.map((l) => l.size), ...bids.map((l) => l.size), 1e-9)

  return (
    <div className="book">
      {asks
        .slice()
        .reverse()
        .map((lvl, i) => (
          <Row key={`a${i}`} lvl={lvl} side="ask" maxSize={maxSize} />
        ))}
      <div className={`midrow ${dir}`}>
        <span className="midpx">{snap.mid.toFixed(2)}</span>
        <span className="spread">spread {snap.spread.toFixed(2)}</span>
        <span className="arrow">{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>
        <span className="vid">{venue.id}</span>
      </div>
      {bids.map((lvl, i) => (
        <Row key={`b${i}`} lvl={lvl} side="bid" maxSize={maxSize} />
      ))}
    </div>
  )
}

function Row({ lvl, side, maxSize }) {
  const pct = Math.max(2, (lvl.size / maxSize) * 100)
  return (
    <div className={`row ${side}`}>
      <span className="depthbar" style={{ width: `${pct}%` }} />
      <span className="px">{lvl.price.toFixed(2)}</span>
      <span className="sz">{lvl.size.toFixed(2)}</span>
    </div>
  )
}
