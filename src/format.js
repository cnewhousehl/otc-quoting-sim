// src/format.js — shared display formatting.
export const fmt = (x, d = 2) =>
  Number.isFinite(x)
    ? x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—'

export const usd = (x, d = 0) => `$${fmt(x, d)}`

export const signedUsd = (x, d = 0) => `${x >= 0 ? '+' : '−'}$${fmt(Math.abs(x), d)}`

// Adaptive price precision: cheap coins need more decimals than BTC.
export function px(p) {
  if (!Number.isFinite(p)) return '—'
  const d = p >= 1000 ? 2 : p >= 1 ? 3 : 5
  return fmt(p, d)
}

// Compact USD (e.g. $1.2M, $43k) for size/total columns in dollar mode.
export function usdCompact(x) {
  const a = Math.abs(x)
  if (a >= 1e6) return `$${fmt(x / 1e6, 2)}M`
  if (a >= 1e3) return `$${fmt(x / 1e3, 1)}k`
  return `$${fmt(x, 0)}`
}

// A coin quantity rendered in the chosen denomination.
export function qty(coin, price, denom) {
  return denom === 'usd' ? usdCompact(coin * price) : fmt(coin, coin < 10 ? 3 : 2)
}
