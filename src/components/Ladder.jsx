import { px, fmt } from '../format.js'

// Cumulative L2 ladder (Hyperliquid-style): Price / Size / Total, depth bars
// scaled to cumulative depth, mid + spread (dollar + bps) in the band.
const DEPTH = 8

function withCumulative(levels) {
  let cum = 0
  return levels.slice(0, DEPTH).map((l) => {
    cum += l.size
    return { ...l, total: cum }
  })
}

export default function Ladder({ snap, dir = 'flat' }) {
  if (!snap) return <div className="loading">…</div>
  const askRows = withCumulative(snap.asks)
  const bidRows = withCumulative(snap.bids)
  const maxTotal = Math.max(askRows.at(-1)?.total ?? 0, bidRows.at(-1)?.total ?? 0, 1e-9)
  const spreadBps = (snap.spread / snap.mid) * 1e4

  return (
    <div className="book">
      <div className="cols">
        <span>Price</span>
        <span className="num">Size</span>
        <span className="num">Total</span>
      </div>
      {askRows
        .slice()
        .reverse()
        .map((l, i) => <Row key={`a${i}`} lvl={l} side="ask" maxTotal={maxTotal} />)}
      <div className={`midrow ${dir}`}>
        <span className="midpx">
          {px(snap.mid)}
          <span className="arrow">{dir === 'up' ? ' ▲' : dir === 'down' ? ' ▼' : ''}</span>
        </span>
        <span className="spreadinfo">
          <span className="spreadabs">${fmt(snap.spread)}</span>
          <span className="spreadbps">{spreadBps.toFixed(1)} bps</span>
        </span>
      </div>
      {bidRows.map((l, i) => <Row key={`b${i}`} lvl={l} side="bid" maxTotal={maxTotal} />)}
    </div>
  )
}

function Row({ lvl, side, maxTotal }) {
  const pct = Math.max(1.5, (lvl.total / maxTotal) * 100)
  return (
    <div className={`row ${side}`}>
      <span className="depthbar" style={{ width: `${pct}%` }} />
      <span className="px">{px(lvl.price)}</span>
      <span className="num sz">{fmt(lvl.size)}</span>
      <span className="num tot">{fmt(lvl.total)}</span>
    </div>
  )
}
