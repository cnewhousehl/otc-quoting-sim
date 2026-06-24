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
