import { px, fmt, usdCompact } from '../format.js'

// Cumulative L2 ladder (Hyperliquid-style). `denom` = 'coin' | 'usd' switches the
// Size/Total columns. `compact` shrinks it for the multi-book grid.
function withCumulative(levels, depth) {
  let cum = 0
  let cumUsd = 0
  return levels.slice(0, depth).map((l) => {
    cum += l.size
    cumUsd += l.size * l.price
    return { ...l, total: cum, usd: l.size * l.price, usdTotal: cumUsd }
  })
}

const sizeCell = (lvl, denom) => (denom === 'usd' ? usdCompact(lvl.usd) : fmt(lvl.size))
const totalCell = (lvl, denom) => (denom === 'usd' ? usdCompact(lvl.usdTotal) : fmt(lvl.total))

export default function Ladder({ snap, dir = 'flat', denom = 'coin', compact = false, depth = 8, showBps = false }) {
  if (!snap) return <div className="loading">…</div>
  const askRows = withCumulative(snap.asks, depth)
  const bidRows = withCumulative(snap.bids, depth)
  const maxTotal = Math.max(askRows.at(-1)?.total ?? 0, bidRows.at(-1)?.total ?? 0, 1e-9)
  const spreadBps = (snap.spread / snap.mid) * 1e4

  return (
    <div className={`book ${compact ? 'compact' : ''}`}>
      <div className="cols">
        <span>{showBps ? 'bps · Price' : 'Price'}</span>
        <span className="num">Size</span>
        <span className="num">Total</span>
      </div>
      {askRows
        .slice()
        .reverse()
        .map((l, i) => <Row key={`a${i}`} lvl={l} side="ask" maxTotal={maxTotal} denom={denom} mid={snap.mid} showBps={showBps} />)}
      <div className={`midrow ${dir}`}>
        <span className="midpx">
          {px(snap.mid)}
          <span className="arrow">{dir === 'up' ? ' ▲' : dir === 'down' ? ' ▼' : ''}</span>
        </span>
        <span className="spreadinfo">
          <span className="spreadbps">{spreadBps.toFixed(1)} bps</span>
        </span>
      </div>
      {bidRows.map((l, i) => <Row key={`b${i}`} lvl={l} side="bid" maxTotal={maxTotal} denom={denom} mid={snap.mid} showBps={showBps} />)}
    </div>
  )
}

function Row({ lvl, side, maxTotal, denom, mid, showBps }) {
  const pct = Math.max(1.5, (lvl.total / maxTotal) * 100)
  const bps = mid ? (Math.abs(lvl.price - mid) / mid) * 1e4 : 0
  return (
    <div className={`row ${side}`}>
      <span className="depthbar" style={{ width: `${pct}%` }} />
      <span className="px">
        {showBps && <span className="lvbps">{bps.toFixed(1)}</span>}
        {px(lvl.price)}
      </span>
      <span className="num sz">{sizeCell(lvl, denom)}</span>
      <span className="num tot">{totalCell(lvl, denom)}</span>
    </div>
  )
}
