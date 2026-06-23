# /engine — deterministic simulation core

Pure, headless JavaScript modules. **No DOM, no `Math.random()`, no `Date.now()`.** Every random draw
pulls from a single seeded RNG in a fixed order, so a session is a pure function of
`(seed, config, studentActions)` and is fully replayable (which is what makes it gradeable).

Planned modules (see [`../PLAN.md`](../PLAN.md) §1.1):

| Module | Responsibility |
|--------|----------------|
| `rng.js` | Seeded PRNG with named sub-streams (price, book jitter, RFQ arrivals, client draws, exec hazard). |
| `clock.js` | Discrete tick loop; per-tick re-evaluation of every live quote; buckets student actions to ticks. |
| `price.js` | Hidden true-mid GBM per asset with regime drift + optional jumps. |
| `book.js` | Per-venue L2 book, walk-the-book VWAP fills, Kyle-λ impact with feedback into the true mid. |
| `resilience.js` | Replenishment of consumed depth toward steady state. |
| `toxicity.js` | Per-venue reaction (widen / thin / skew) to the student's signed flow, with healing. |
| `client.js` | Named client archetype roster (sharp/toxic ↔ soft) and their behavior parameters. |
| `rfq.js` | Poisson RFQ arrivals, liquidity-coupled sizing, `maxPendingRFQs` enforcement. |
| `quote.js` | Live quote lifecycle: live → filled / cancelled / refreshed / expired, with TTL. |
| `fill.js` | Continuous per-tick execution-hazard model (the staleness / pickoff mechanic). |
| `pnl.js` | P&L decomposition: gross spread, hedge slippage, inventory MtM, adverse selection, fees. |
| `session.js` | Config wiring, event log, public API, headless `runFromSeed` for future benchmark bots. |
