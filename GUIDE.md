# Instructor & Operator Guide

The complete reference for the OTC Quoting Simulator: **what it teaches**, **every
parameter you can change**, and **what we want to reward vs punish**. Read this on
GitHub to understand and tune the sim without reading code.

Companion docs:
- [`LESSONS.md`](LESSONS.md) — the full catalog of teachable moments + status.
- [`TRADING_MODEL.md`](TRADING_MODEL.md) — the economic/trading model (the "how").
- [`PLAN.md`](PLAN.md) — the build plan & quantitative core (Q1–Q8).

---

## 1. What it is
A crypto OTC desk market-making trainer. Named clients send RFQs; the student
streams a two-way price; if filled they take inventory and must hedge into a
multi-venue book (T1/T2 perps + a DEX AMM) — learning that the quoted spread is
only gross edge: realized P&L is spread − hedge slippage − adverse selection ±
warehoused inventory, with macro **news** moving the hidden true price.

## 2. Run it
```
npm install
npm run dev     # play locally (lobby → trading desk)
npm test        # 111 deterministic engine tests
npm run build   # static bundle for GitHub Pages
```
`?seed=<n>` reproduces a path; `?tier=free` previews the gated (free-to-play) build.

## 3. What the engine teaches (summary)
See [`LESSONS.md`](LESSONS.md) for the full list with mechanisms. Headlines:
- **Staleness** — live quotes get picked off as the market moves; refresh or go off.
- **Quote tight for sharp flow, wide for retail** — and width genuinely matters
  (you can win ~1% depending on size, counterparty bias, and what you know).
- **Toxic flow & adverse selection** — winning informed flow too easily costs you.
- **Inventory skew / internalization** — don't always hedge; skew to flatten.
- **Execution** — smash size = worse fill; clip slowly = books stay firm & refill;
  split across T1/T2/DEX; hitting one venue widens the others; passive vs market.
- **Correlation** — alts co-move with BTC/ETH, so hedge alt risk with majors.
- **Client bias & news** — bullish clients lift wider offers; a sharp client's
  bias predicts the drift, so you can **pre-position against informed flow**.

## 4. Parameters you can change
All config is data in `/config` — no engine edits to retune.

### 4a. Difficulty — `config/difficulty.js` (one dial rewrites everything)
| Param | Meaning | Easy → Hard |
|---|---|---|
| `pTox` | toxic/sharp share of flow | 0.15 → 0.60 |
| `reservationBps` | soft-fill width scale (how wide clients still trade) | 90 → 38 |
| `soft.{lambda,s0,s1,omega,b}` | soft willingness curve shape | — |
| `sharp.{q0,aPick,theta,b}` | sharp pickoff curve (softplus) | — |
| `pickoffScale` | stale-pickoff aggression | 0.6 → 1.0 |
| `toxic.{deltaTox,N,rho}` | post-fill adverse drift size/horizon/decay | 0.8σ → 2.6σ |
| `eta` | size penalty on fills | 0.30 → 0.12 |
| `hazardScale` | global fill-hazard multiplier (calibration knob) | 0.075 |
| `arrivalRate` | RFQs per second | 0.5 → 1.2 |
| `maxPendingRFQs` | inbox cap | 3 → 8 |
| `transparency` | name/bias reveal | full → hidden |
| `bookUpdateSec` | book repaint cadence | 5s → 1s |

### 4b. Venues — `config/venues.js`
- `EXCHANGES`: per-venue profile — `halfSpreadBps`, `levelStepBps`, `depthTopNotional`,
  `k0` (depth decay), `kyleLambda`/`phi` (impact + true-mid feedback), `tau`
  (depth regrowth), `lagTau` (T2 staleness), `updateMult` (relative cadence),
  `tox.*` (spread-widen/depth-thin/skew sensitivities), and AMM `feeBps`/`poolNotional`.
- `ASSET_UNIVERSE`: `refPrice`, `sigma` (per-tick vol — annualizes to ~55–165%),
  `corr` (loading on the common market factor), `weight` (arrival frequency),
  and `venues` (which venues list it — esoteric coins are DEX-only).
- `crossVenueContagion` (in `book.js`, default 0.4): how much hitting one venue
  leaks to siblings.

### 4c. Clients — `config/clients.js`
`ROSTER` of invented desk handles → `archetype` (sharp/mid/soft), `tell`, and
`size` profile. Name→toxicity transparency is difficulty-gated.

### 4d. News — `config/news.js`
`NEWS_CATALOGUE` (10 catalysts): `scope` (macro/asset), `direction`, `magnitude`
(small/medium/large). `MAGNITUDE` sets the total return & horizon. Cadence is the
lobby's "news cadence" (1–10 min). Add catalysts freely.

### 4e. Session — `config/session.js`
`SCENARIOS` (calm/trending/vol-spike/toxic-day → regime + vol/jump multipliers),
plus `dt`, `ttlTicks` (quote life), `pendingTtlTicks` (RFQ response window),
`hedgeFeeBps`, `softInventoryUsd`, jump params.

### 4f. Licensing — `config/entitlements.js`
`TIERS` (free/pro/instructor) gate Hard mode, custom config, scenarios, session
length, replay export, white-label. Free keeps the toxic-flow lesson intact.

## 5. What to reward vs punish (grading philosophy)
The Phase-3 grader (designed, not yet built) scores **benchmark-relative** on a
path: interpolate each metric between a strawman floor and an Avellaneda–Stoikov
optimal on the *same seed*, neutralizing luck. Tensioned axes:

**Reward**
- Net spread capture (after hedge cost & adverse selection), not gross.
- Inventory discipline & timely hedging; **internalization** (flattening via client
  flow instead of always paying the book).
- Adverse-selection avoidance (refreshing stale quotes; pricing toxic names wide
  enough; pre-positioning against informed flow).
- Smart execution (clipping, venue split, passive fills, using stale T2).
- Risk-adjusted P&L (Sortino-style — steady beats lucky), market presence
  (you actually quote), good tail behavior.

**Punish**
- Leaving stale quotes live into adverse moves (pickoffs).
- Quoting toxic names tighter than the break-even width.
- Smashing size / chasing liquidity; ignoring hedges into news.
- Warehousing oversized inventory past the soft limit without a view.

## 6. File map
```
engine/   rng price book perpVenue amm resilience toxicity client fill
          quote pnl rfq news clock session   (pure, headless, seed-deterministic)
config/   difficulty venues clients news session entitlements
src/      React desk UI (lobby + session view)  ·  test/  Vitest suites
```

## 7. Status
Engine + UI complete through the playable loop (RFQs → quotes → fills → hedging →
news → multi-venue books). Remaining: **M10** (formal calibration gate) and
**M11** (agent-MM matching LOB → emergent spreads, the "Agent-MM" book option).
