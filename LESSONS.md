# Lessons — what the simulator teaches

A living catalog of the teachable moments the sim can produce, the engine
mechanism behind each, and where it's surfaced. ✅ = implemented & tested,
🔶 = partial, ➕ = planned. Pair with `TRADING_MODEL.md` (the how) — this is the
what/why for instructors.

## Quoting & staleness
- ✅ **Price to the hedge, in real time.** A counterparty's willingness is anchored
  to what it costs YOU to hedge their clip on the *live* book (size vs venue
  liquidity), not a fixed number. Sharp/sophisticated names trade near the
  hedgeable price + a small spread and **almost never let you fill them wide**
  unless their clip is huge vs the book; retail is far more flexible. Because the
  "winning" width tracks the moving book, it's not memorizable — you must read it.
  *(fill.js hedge-cost-anchored model; `estimateHedgeWidth`)*
- ✅ **Relationship / franchise value.** Give a client a run of tight, fair fills
  and they build **favor** — they'll then accept the occasional wider one-off. But
  a wide one-off **burns** favor, so they turn demanding again until you rebuild
  trust. Stronger for mid/sophisticated (relationship-driven) names. *(session
  favor state; revealed on Easy)*
- ✅ **Don't leave stale quotes live.** A quote is executable from submit until you
  cancel/refresh/expire; clients pick off quotes the market has moved through.
  *(quote.js/fill.js; M6 staleness tests)*
- ✅ **Refreshing a stale quote is +EV; holding is −EV.** `E[PnL|hold] < E[PnL|refresh]`.
- ✅ **Quote tighter to win sharp flow, wider for retail.** `g_sharp` only trades
  near fair; `g_soft` trades even wide. *(fill.js archetypes)*
- ✅ **Toxic break-even width.** Quoting tighter than `≈ δ_tox·σ_M/2` to a sharp
  name is mean-negative — winning informed flow costs you adverse selection.
- ✅ **Price in the hedge, not just the mid.** DEX-only/illiquid names and stale T2
  mean your quote must be wider. *(venues.js, isDexOnly)*
- 🔶 **Widen for size.** Bigger clips are harder to warehouse/hedge → deserve wider
  spreads (emergent via hedge slippage; to be rewarded explicitly in grading).

## Inventory & risk
- ✅ **Skew to your axe / internalize.** Holding inventory, skew your two-way to
  attract flow that flattens you — capture spread instead of paying hedge
  slippage. *(skew slider; independent side hazards)*
- ✅ **Slow hedging → adverse mark-to-market.** Warehoused inventory swings with the
  mid (InvMtM + AdvSel). *(pnl.js)*
- ✅ **Holding into news = big gains/losses.** News pivots the true mid. *(news.js)*
- ✅ **Hedge alt risk with majors.** Alts co-move ~0.7–0.92 with BTC/ETH via a
  common market factor, so a BTC/ETH hedge offsets much of an alt position.
  *(price.js correlation)*
- 🔶 **Aggregate delta, not per-ticket.** Manage net USD delta across names. *(usdDelta)*
- ➕ **Funding/carry on perps** (liked but deferred — too fast-paced for now).

## Execution & venues
- ✅ **Smash size = worse fill; clip slowly = price risk but firmer books.**
  Walk-the-book VWAP + toxicity (fast/big flow looks toxic → widen/thin) +
  resilience (regrows between clips). *(perpVenue.js)*
- ✅ **Slow down and the book replenishes.** Depth regrows toward steady; toxicity
  heals when flow stops.
- ✅ **Split hedges across T1/T2/DEX.** Less per-venue impact; hit a stale-cheap T2;
  exact small clips on the DEX.
- ✅ **Hitting one venue moves the others.** Aggressive flow on T1 widens T2 spreads
  / thins depth (cross-venue contagion). DEX (a curve) is immune.
- ✅ **Passive vs aggressive hedging.** A resting limit fills at your price with no
  slippage — but may never fill (save-the-spread vs miss-the-hedge). Pre-arm an
  instant hedge. *(limit hedging)*

## Counterparty & information
- ✅ **Know your counterparty.** Named archetypes; toxicity/bias revealed on Easy,
  inferred on Hard. *(clients.js transparency)*
- ✅ **Winner's curse.** If a sharp lifts you instantly, you were mispriced and
  about to be run over (adverse drift follows). *(toxic flow)*
- ✅ **Read client bias.** Bullish clients lift wider offers, bearish hit wider
  bids; news sentiment tilts the whole book's bias, then fades. *(bias engine)*
- ✅ **Pre-position against informed flow.** A sharp client's *bias* drives the
  post-fill drift direction — so if you know Citadel-type flow is bearish, you can
  accumulate the offsetting position from non-toxic clients *first*, then trade the
  informed flow already (partly) hedged and not lose. *(bias → drift sign)*
- ✅ **Information leakage.** Your hedging footprint moves the mid (φ feedback) and
  signals across venues (contagion).

## Macro / news
- ✅ **Trade around catalysts.** 10 macro/asset catalysts on a 1–10 min cadence,
  small/medium/large signed impact, slow pivots (read the tape, position into it).
- ✅ **Sentiment fades.** A headline's effect on client bias decays over ~1.5 min.

## Process / discipline (mostly Phase-3 grader)
- ✅ **Infer fair from the tape, not one venue.** True mid is hidden; multiple
  books + a stale T2 mean no single mid is "the" price.
- ➕ **Markout discipline** — judge a fill by where the mid is 5/30s later.
- ➕ **Risk-adjusted, not raw P&L** — Sortino-style scoring rewards a steady book.

## Difficulty gating
- **Easy** reveals archetype + bias + tells; lower toxicity/pickoff; calmer flow.
- **Medium** hints; **Hard** masks names/bias, higher toxic share, full pickoff,
  faster arrivals — you must infer toxicity from size, asset, venue, and flow.
