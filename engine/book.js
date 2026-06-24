// engine/book.js
//
// Market aggregator (M3 interface, M7 multi-venue). Holds a set of venue
// handlers — perp order-book venues (engine/perpVenue.js) and constant-product
// DEX venues (engine/amm.js) — behind ONE stable interface so the Phase-1b
// agent-MM LOB (M11) can replace any venue handler without touching callers:
//
//   getBookSnapshot(venueId)        -> { mid, spread, bids[], asks[] }
//   executeMarketable({venueId,..}) -> { vwap, filledSize, slippage, ... }
//   mid(venueId)                    -> reference mid
//   tick(n)                         -> advance every venue
//   venueIds() / venuesForAsset(id) -> routing
//
// A venue config's `type` selects the handler ('perp' default, 'amm'). All
// venues are perpetual-futures-style except the AMM (a DEX pool).

import { createPerpVenue } from './perpVenue.js'
import { createAmmVenue } from './amm.js'

export function createBook({ rng, price, venues, dt = 0.25, crossVenueContagion = 0.4 }) {
  const handlers = new Map()
  for (const v of venues) {
    const type = v.type ?? 'perp'
    const handler =
      type === 'amm'
        ? createAmmVenue({ price, dt, cfg: v })
        : createPerpVenue({ rng, price, dt, cfg: v })
    handlers.set(v.id, handler)
  }

  const need = (id) => {
    const h = handlers.get(id)
    if (!h) throw new Error(`unknown venue: ${id}`)
    return h
  }

  return {
    mid: (venueId) => need(venueId).mid(),
    getBookSnapshot: (venueId) => need(venueId).getBookSnapshot(),
    executeMarketable: ({ venueId, side, size }) => {
      const h = need(venueId)
      const r = h.executeMarketable({ side, size })
      // Contagion: sibling perp venues on the same asset feel a fraction of the
      // flow (their makers infer informed/aggressive flow market-wide).
      if (h.type === 'perp' && crossVenueContagion > 0) {
        const signed = (side === 'buy' ? r.filledSize : -r.filledSize) * crossVenueContagion
        for (const sib of handlers.values()) {
          if (sib !== h && sib.assetId === h.assetId && sib.observeExternalFlow) {
            sib.observeExternalFlow(signed)
          }
        }
      }
      return { venueId, assetId: h.assetId, ...r }
    },
    estimateCost: (venueId, side, size) => need(venueId).estimateCost(side, size),
    tick: (n) => {
      for (const h of handlers.values()) h.tick(n)
    },
    setStress: (s) => {
      for (const h of handlers.values()) h.setStress?.(s)
    },
    venueIds: () => [...handlers.keys()],
    venuesForAsset: (assetId) => [...handlers.values()].filter((h) => h.assetId === assetId).map((h) => h.id),
    venueInfo: (venueId) => {
      const h = need(venueId)
      return { id: h.id, assetId: h.assetId, type: h.type, tier: h.tier }
    },
  }
}
