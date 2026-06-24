# Build Plan — Spot OTC Quoting Simulator (Crypto Desk)

## Context

Phase 1 (spot) of a two-phase teaching tool for an MFE-level course (FINM 35600, "Institutional
Crypto Markets"). It trains students to think like a market-maker on a crypto OTC desk: clients send
RFQs, the student streams a two-way price, may get filled, takes on inventory, and must hedge into a
simulated multi-venue book. The pedagogical core is that the **quoted spread is only gross edge** —
realized P&L is that spread minus hedge impact, minus adverse selection on informed flow, plus/minus
warehoused inventory.

The instructor (Chris Newhouse) provided a detailed build spec and then refined it with three
defining requirements that change the engine design versus a vanilla market-making sim:

1. **Live, executable quotes with staleness risk.** The market moves in the background while a quote
   sits live. A client has a window (~30 s) to trade against it. If the market moves and the quote is
   still live, the client can trade the **stale** price and the student eats the risk. The student
   must cancel ("off") or refresh. This teaches not leaving prices live too long. This replaces the
   spec's one-shot logistic fill with a **continuous execution-hazard model over the quote's life.**
2. **Easy / Medium / Hard difficulty** as a single dial that rewrites a bundle of engine parameters
   (toxic share, fill-vs-width sensitivity, stale-pickoff aggression, max pending RFQs, arrival rate,
   post-fill drift, and how transparently client names reveal toxicity).
3. **Named client archetypes whose names encode flow toxicity** (e.g. a Citadel-like sharp = toxic:
   you must quote tighter to win and it moves against you; a Noob-Trader-like = soft: quote wider and
   win, low adverse drift). On Easy the name telegraphs the archetype; on Hard it's masked.

This document is the **Phase 1 (trading engine) plan**, with the UI and grading phases scoped at the
end so the engine exposes the right interface to both. Per instructor direction the work is phased
**engine → UI → grading**, and this plan focuses on the engine.

### Locked decisions
- **Repo:** new standalone public repo at `C:\Users\cnewh\Desktop\personal-projects\otc-quoting-sim`
  (sibling to `hip3-analysis`). `gh` is already authenticated as `cnewhousehl`.
- **Stack:** Vite + React + Vitest. Pure JS engine modules (no DOM) under `/engine`; React terminal
  UI under `/ui`; Vitest determinism + unit tests under `/test`; static build deploys to GitHub Pages.
- **Environment confirmed:** Node v24.13.0, npm 11.6.2, git 2.52, `gh` authed. Greenfield — no
  existing JS to reconcile.
- **First milestone:** deterministic trading engine + Telegram-style UI. Grading (the benchmark-
  relative balanced scorecard, already designed) is a later phase.
- **Spec defaults adopted** (instructor said defaults assumed if unanswered): two-way streamed quote
  per RFQ; warehousing allowed (discretionary, soft limit); fully synthetic data, no external APIs;
  seed-deterministic per student.

---

## Phase 0 — Repo bootstrap ✅ COMPLETE

Scaffold, CI, and Pages deploy are all in place (Vite + React + Vitest, `LICENSE`, `.gitignore`,
`.github/workflows/deploy.yml`, public `README.md`, remote `origin` wired and pushed). The **one
remaining bootstrap verification item** is confirming the `?seed=<id>` URL param works on the hosted
Pages bundle. Original bootstrap steps, for the record:

1. `git init` a new repo at `C:\Users\cnewh\Desktop\personal-projects\otc-quoting-sim`.
2. Scaffold Vite + React (`npm create vite@latest . -- --template react`), add Vitest.
3. Directory layout:
   ```
   /engine    rng, clock, price, book, resilience, toxicity, client, rfq, quote, fill, pnl, session
   /ui        React terminal (Phase 2)
   /test      Vitest determinism + unit suites
   /config    difficulty presets + scenario presets + asset universe (single tunable config object)
   ```
4. `README.md` (public-facing: what it is, how to run, how seeds work), MIT `LICENSE`, `.gitignore`.
5. `gh repo create otc-quoting-sim --public --source . --remote origin`, initial commit, push.
6. Wire GitHub Pages via Vite `base` + a Pages deploy (Actions workflow or `gh-pages`). Confirm the
   `?seed=<id>` URL param works on the hosted bundle.

> Bootstrap unblocks the failed `ultraplan` cloud launch (it failed only because there was no git repo).

---

## Phase 1 — The trading engine (focus of this plan)

**Design priority: realism + determinism.** The engine is a pure, headless, seed-deterministic state
machine. No `Math.random()`, no `Date.now()` inside `/engine`; every draw pulls from one seeded RNG
in a fixed order so a session is a pure function of `(seed, config, studentActions)` and is fully
replayable for grading.

### 1.1 Module map (`/engine`)

| Module | Responsibility |
|--------|----------------|
| `rng.js` | Seeded PRNG (mulberry32/xoshiro128**); named sub-streams per concern (price, book jitter, RFQ arrivals, client draws, execution hazard) so adding a feature doesn't shift unrelated draws. |
| `clock.js` | Discrete tick loop (default 250 ms wall → configurable sim-dt). Drives price ticks, RFQ arrivals, and **per-tick re-evaluation of every live quote**. Buckets async student actions to the tick they arrive on. |
| `price.js` | Hidden true-mid `M_t` per asset: GBM with regime-switchable drift {flat, up, down, mean-revert} + optional Poisson jumps. True mid is **never shown**; students infer fair from the books. |
| `book.js` | **Stable `book` interface with two implementations (see §1.8): 1a parametric ladder, 1b agent-MM matching LOB.** Per-venue L2 ladder: reference mid `m_v = M_t + basis_v + ε_v`, half-spread + depth profile `D_v·exp(−k/k0)` by liquidity tier, seeded size jitter. Walk-the-book VWAP fills; Kyle-λ permanent impact `λ_v·signed/D_v` with a fraction `φ` feeding back into `M_t` (your flow is information). |
| `resilience.js` | **Parametric in 1a → emergent in 1b** (MMs re-posting on their own cadence). Consumed levels regrow toward steady state with venue time-constant `τ_v` → small clips with pauses beat one sweep. |
| `toxicity.js` | **Parametric in 1a → emergent in 1b** (MMs detecting adverse flow and pulling/widening). Per-venue EWMA of the student's signed flow → widen `s_v`, thin hit-side depth, skew `m_v` away; heals when flow stops. (The "bids disappear when I smash the bid" behavior.) |
| `maker.js` | **NEW (Phase 1b).** Market-maker agent population per venue: each MM has perception noise on `M_t`, a base half-spread, a reaction latency, and a quoting style (symmetric vs A–S inventory-skew). Difficulty tunes the population (count, spread mix, reaction-speed mix, perception noise, inventory aggressiveness). |
| `match.js` | **NEW (Phase 1b).** Price-time-priority matching engine: MM limit orders rest; a marketable order trades against the resting opposite side and uncrosses the book the same tick (crossing is a trade, not a bug). |
| `client.js` | **NEW — client archetype roster.** Each RFQ is issued by a named client with a profile: informed-probability, reservation spread (how tight to win), stale-pickoff aggression, size distribution, post-fill drift magnitude. Name→archetype transparency is difficulty-controlled. |
| `rfq.js` | Poisson RFQ arrivals (rate from difficulty). Asset drawn from weighted universe (majors frequent, esoterics rare). Size coupled to current liquidity (size = depth-within-band × LogNormal multiplier) → mix of easy small clips and dangerous large clips. **Enforces `maxPendingRFQs`** (queue/suppress new arrivals when the cap is hit). |
| `quote.js` | **NEW — live quote lifecycle.** A student two-way (bid,ask) for an RFQ becomes a LIVE object with a TTL (default 30 s). States: live → filled / cancelled("off") / refreshed(re-quote at new fair) / expired. Holds the prices at which it is currently executable. |
| `fill.js` | **REWORKED — continuous execution hazard.** Each tick, for every live quote, the issuing client may execute against the still-live price. Per-tick hazard is a function of the quote's edge vs **current** fair (signed by side), the client archetype, and difficulty. Sharp/toxic clients pick off stale in-the-money quotes fast and their fills precede further adverse drift; soft clients execute more randomly and less informedly. On fill the student takes the opposite side at the quoted (possibly stale) price. |
| `pnl.js` | Per-trade + aggregate decomposition: gross spread captured, hedge slippage, inventory MtM, adverse selection (post-fill drift attributable to informed flow), fees. Maintains positions, USD delta, cash, realized/unrealized, full blotter + hedge log. |
| `session.js` | Wires config + scenario + difficulty, owns the event log, exposes the public API (below), and the headless `runFromSeed(seed, config, quotePolicy)` used later by benchmark bots. |

### 1.2 The live-quote / staleness model (the core mechanic)

This is the heart of the realism the instructor wants. Lifecycle per RFQ:

1. RFQ arrives from named client *C*: "Looking for a two-way on $X of [ASSET]."
2. Student streams `(bid, ask)`. Quote goes **live** with TTL (default 30 s) and is **executable at
   those prices until cancelled/refreshed/expired** — even as `M_t` drifts.
3. Each tick while live, `fill.js` draws *C*'s execution decision from a hazard intensity:
   - `edge_side = (current_fair − quote_level)` signed so a quote that has gone **off-market in the
     client's favor** (stale, picked-off) raises the hazard sharply.
   - Sharp/toxic *C*: high pickoff hazard on stale in-the-money quotes; **fill is followed by adverse
     drift** of `M_t` (informed). This is the lesson — leave a bid up while the market falls and a
     sharp lifts/hits you, then it keeps going against you.
   - Soft *C*: trades even at prices off-market to itself (pays your spread), low/again post-fill drift.
4. Student defenses: **cancel ("off")**, **refresh** (re-quote at current fair — continuously
   allowed), or hedge existing inventory. Letting a quote sit = taking free option risk against
   informed flow.
5. No execution by TTL → RFQ closes flat.

Determinism note: the per-tick hazard draw per live quote comes from the `clientExec` sub-stream in a
fixed order; student actions are logged with their sim-tick so replay reproduces the session exactly.

### 1.3 Difficulty presets (`/config/difficulty.js`)

A single `difficulty ∈ {easy, medium, hard}` selects a parameter bundle. Indicative values
(`[CALIBRATE]` — instructor tunes; all exposed in one config object):

| Parameter | Easy | Medium | Hard |
|-----------|------|--------|------|
| Toxic/informed share `p_tox` | ~0.15 | ~0.35 | **0.50–0.75** |
| Fill-vs-width sensitivity `β` | low (win even when wide) | medium | high (must quote tight to win) |
| Stale-pickoff aggression | damped when it would hurt the student | neutral | full (sharp clients reliably pick off) |
| Post-fill adverse drift `δ_tox` | small | medium | large |
| `maxPendingRFQs` default | **3** | 5 | higher / uncapped |
| RFQ arrival rate `λ` | lower | medium | higher |
| Name→toxicity transparency | shown (Citadel=toxic, Noob=soft) | hinted | masked |

Design guardrail: **even on Hard, win-probability on well-priced quotes stays high** so students still
trade and learn — Hard makes flow *toxic and fast*, not *untradeable*. Difficulty only overrides
defaults; the engine logic is identical across levels.

### 1.4 Client archetype roster (`/config/clients.js`)

A small roster of named counterparties, each mapped to an archetype (sharp/toxic, mid, soft):
informed-probability, reservation spread, pickoff aggression, size profile, post-fill drift. On Easy
the name reveals the archetype (teaching the intuition: price Citadel tight or lose / get run over;
price Noob wide and bank soft spread). On Hard the names are masked/shuffled so students must infer
toxicity from size, asset, and recent flow. Names are illustrative/parodic — **no real-firm framing in
student-facing copy** (course non-compete rule); use invented desk-style handles.

### 1.5 Settings exposed (`/config/session.js`)
`seed`, `difficulty`, `maxPendingRFQs`, `sessionLength` (default 20 min), `scenario`
{calm, trending, vol-spike, toxic-day}, quote `TTL` (default 30 s), asset universe + per-tier
vol/depth/spread/`τ`/`λ_v`/`φ`, fees, soft inventory limit. One object; no engine edits to tune.

### 1.6 Public engine API (consumed by UI in Phase 2, grading in Phase 3)
- `createSession({seed, config})` → session handle.
- `tick()` / run loop → advances time, returns events (price update, new RFQ, quote state change,
  fill, book update).
- `submitQuote(rfqId, {bid, ask})`, `cancelQuote(rfqId)`, `refreshQuote(rfqId)`.
- `hedge({asset, size, venue|split, type:'market'})` (passive/limit = Phase 1.5).
- `getState()` → positions, delta, cash, P&L decomposition, live quotes, blotter, books.
- `getEventLog()` → the replayable log (the grading artifact).
- `runFromSeed(seed, config, quotePolicy)` → headless replay for benchmark bots (Phase 3).

### 1.7 Testing (`/test`, Vitest) — gate for "engine done"
- **Determinism:** same `(seed, config, scriptedActions)` ⇒ byte-identical event log; different seed ⇒
  different log.
- **Unit:** walk-the-book VWAP & impact monotonicity; resilience regrowth; toxicity widen/heal;
  staleness (a quote left live through an adverse move gets picked off by a sharp client and shows
  negative adverse-selection P&L); `maxPendingRFQs` enforcement; difficulty bundle wiring; P&L
  decomposition identity (components sum to net).

### 1.8 Hedging-market model (phased agent-based market makers behind the `book` API)

The sim has two distinct liquidity relationships; this section concerns only the second:

1. **Clients → Student** — RFQ → student two-way → client fills via the Q1–Q8 execution-hazard
   model. This is the student's revenue side and the pedagogical centerpiece. **Unchanged by this
   section** (clients are takers, not market makers).
2. **Student → Market** — the student hedges inventory into a venue book. This is the *only* place
   the book/MM model lives, and what fair-price discovery is built on.

**Architecture: agent MMs post into a real (mini) matching LOB.** Rather than free-floating
independent quotes (which can lock/cross), 3–5 market-maker agents per venue post limit orders into a
price-time-priority matching engine. A would-be cross is simply a **marketable order that trades**
against the resting opposite side and uncrosses the book the same tick — crossing is a trade, not a
bug, so no ad-hoc clamps are needed.

**MM heterogeneity (the sophistication dial):** each MM has perception noise on the hidden mid `M_t`
(sharper MMs see fair better), a base half-spread, a **reaction latency** (fast vs delayed
quote-pulling when adversely traded), and a quoting style — **symmetric around fair** vs
**inventory-skewed** (Avellaneda–Stoikov reservation price `r = fair − inventory·γ·σ²`).

**What becomes emergent (vs. parametric hacks):** `toxicity.js` (depth vanishing when the student
leans on one side) emerges from MMs detecting adverse flow and pulling/widening; `resilience.js`
(depth regrowth) emerges from MMs re-posting on their own cadence; **skew** emerges from
inventory-managing MMs; **Kyle-λ impact** emerges from consuming finite MM depth plus MMs inferring
the student is informed and repricing. Inter-MM prints also give the student a realistic **tape** to
infer fair from — the exact skill being taught.

**Phasing (de-risks the centerpiece):**

- **Phase 1a — parametric book baseline.** Build the Q1–Q8 client/hazard core against a simple
  parametric book behind a stable `book` interface (`getBookSnapshot()`, `executeMarketable(order)`,
  `mid()`, `tick()`...). The staleness lesson ships and calibrates fast, independent of the ABM.
- **Phase 1b — agent-MM matching LOB.** Swap in the matching engine (`match.js`) + MM population
  (`maker.js`) as a drop-in behind the same `book` interface. `toxicity.js`/`resilience.js` collapse
  into MM behavior (or become thin shims). The parametric book is retained as a **test double**.

**Determinism:** add a `maker` sub-stream keyed by `makerId` (perception noise, size jitter, reaction
jitter addressed by `(makerId, tick)`), consistent with the Q4 counter-based addressing — adding or
removing a maker shifts no other draw.

**Calibration caveat:** spread/depth/impact become *indirect* — the Easy/Med/Hard dial tunes
MM-population parameters (count, spread distribution, reaction-speed mix, perception noise, inventory
aggressiveness) to *produce* target book statistics, with parametric guardrails (floor on posted
depth, cap on spread) so difficulty stays monotone. Q7 gains invariants on the emergent book.

---

## Phase 1 Engine — Quantitative Core (detailed spec)

This expands §1.2–§1.3 with the math the build must implement. Validated in a dedicated design pass.

### Q1. Time & RNG base

- Tick `n`, sim time `t = n·dt`, default `dt = 0.25 s` → `TTL_ticks = round(30/dt) = 120`.
- Per-asset hidden true mid `M_t`; per-tick price-stdev `σ_M` (asset-specific) is the unit for all
  hazard math, so edges are dimensionless in `edge/σ_M`.
- Counter-based PRNG (PCG32 / SplitMix→xoshiro) addressed by `(streamId, n, entityKey, localIdx)`,
  **not** a single linear stream. Gaussians via inverse-CDF (Moro/Acklam) so one uniform → one normal
  (exact 1:1 draw accounting). This addressing is what guarantees stream isolation (Q3).

### Q2. Per-tick execution-hazard model (the centerpiece)

A live quote to client *C*, notional `X`, frozen `studentBid`/`studentAsk`. Signed edge in the
client's favor, normalized: `e_ask = (M_t − studentAsk)/σ_M` (client lifts/buys),
`e_bid = (studentBid − M_t)/σ_M` (client hits/sells). `e>0` = stale, in-the-money to client (pickoff
zone); at fair-symmetric creation both sides start at `−w/σ_M < 0` (client pays your half-spread `w`).

Per-side fill prob = `1 − exp(−h·dt)`, intensity `h_side = λ_C · g_arch(e_side; C) · L(X) · R_dur(τ) · D_diff`:

- **Soft** (uninformed, pays spread): `g_soft(e) = s0 + s1·logistic((e+ω_soft)/b_soft)`. Large floor
  `s0` ⇒ soft clients still trade when `e<0` → this is the spread-capture engine; roughly flat in `e`.
- **Sharp** (informed, picks off): `g_sharp(e) = q0 + A_pick·softplus((e−θ_sharp)/b_sharp)`. Tiny `q0`
  ⇒ rarely trades on-market; softplus ⇒ hazard spikes once the quote goes stale-in-the-money.
- `L(X) = (X/X_ref)^(−η)` (clamped) — bigger clips harder to fill; `R_dur(τ) = 1 − exp(−τ/τ_react)`
  decision latency; `D_diff` global difficulty scaler.
- **Competing risks:** bid-fill and ask-fill are independent hazards on the same quote; first to fire
  consumes it; same-tick tie → larger `e_side` wins (deterministic, no extra draw).
- **Emergent win-rate:** `WinRate(w) ≈ 1 − exp(−λ_C·ḡ_soft(−w/σ_M)·TTL)` — a decreasing S-curve in
  width; difficulty shifts it via `λ_C`, `s0`, `ω_soft`.
- **Teaching invariant (why staleness is −EV):** if `M_t` drifts adversely, `e_side` rises linearly,
  so (i) sharp hazard rises — you get filled exactly when it's worst — and (ii) fill severity
  `−σ_M·e_side` worsens. `E[PnL_hold] = Σ f(n)·(−σ_M·e(n)) < +w` and goes negative under pickoff.
  Refreshing resets `e → −w/σ_M`, collapsing sharp hazard to `q0` and restoring `+w` capture. The
  optimal policy is a refresh-when-`e≥e*` stopping rule — exactly what the A–S benchmark approximates.

### Q3. Informed/toxic flow realization

- **Sample at RFQ creation, activate on fill.** At creation, draw client, `isToxic ~ p_tox` (≈0 for
  soft archetype), and the entire post-fill adverse-drift path; store on the RFQ. Drift only injects
  into `M_t` if a toxic fill occurs. Chosen over sample-at-fill because it (a) preserves the
  counterfactual ("the right/refreshed quote could have dodged it") needed for honest grading, (b)
  keeps the stream isolated from student actions, (c) is the truer microstructure story (the client is
  informed when they ask).
- **Drift shape:** on a toxic fill, add `μ_tox(k) = χ·δ_tox·ρ^k/Z` for `k=0..N−1` on top of GBM —
  exponential-decay (front-loaded), superposable across overlapping toxic fills. `χ` = adverse sign.
- **Attribution:** track `r_tox` as a separate additive component of each tick's `M` update;
  `AdvSel_n = position·M·r_tox`, `InvMtM_n = position·M·r_GBM`. This is the clean split the grader
  needs. P&L identity (unit-tested): `Realized = GrossSpread + InvMtM + AdvSel + HedgeSlippage − Fees`.

### Q4. Determinism ordering

Fixed sub-stream registry, consumed each tick in order:
`price → jump → book → maker → rfqArrival → rfqSpec → execHazard → venueReact`. (`maker`, keyed by
`makerId`, is Phase 1b; in 1a it is unused so it shifts no other draw.) Isolation rule: draws are
addressed by stable entity key (`execHazard` keyed by `quoteId`, `rfqSpec` by `rfqId`, `maker` by
`makerId`, `price`/`book` by asset/venue id), so whether quote #7 exists has zero effect on any other
quote's or stream's draws. Per-tick loop:

1. apply student actions [no draws]
2. advance `M` [GBM + active `μ_tox`]
3. jumps
4. books + resilience (1a parametric; 1b = MM quote/pull + matching)
5. create RFQs (pre-sample drift)
6. expire TTL quotes
7. `execHazard` in ascending `quoteId`, resolve fills, activate toxic drift
8. accounting + event log
9. venue toxicity EWMA (1a parametric; 1b emergent from MM state)

`runFromSeed(seed, config, quotePolicy)` runs a deterministic `(observableState)→actions` callback at
step 1 — student replay, strawman, and A–S bot are just different policies on the identical path.

### Q5. Event-log schema (P&L + grader computable from the log alone)

Each record stamps: `tick`, `type`, `quoteId?`, `rfqId?`, `clientId?`, `archetype?`, `isToxic?`,
`assetId`, `side?`, `sizeX?`, `price?`, `fairMid_at_event`, `edge_sigma?` (staleness at fill),
`position_after?`, `r_GBM?`, `r_tox?`, `invMtM_delta?`, `advSel_delta?`, `venueId?`, `vwap?`,
`hedgeSlippage?`, `fees?`, `cash_after`. `GrossSpread`, `AdvSel`, `InvMtM`, `HedgeSlippage`, `Fees`
all reduce directly from this; the grader recomputes benchmark PnL by re-running `runFromSeed` with a
bot policy and the identical accounting.

### Q6. Difficulty → concrete coefficients (replaces the indicative §1.3 table)

| Param | Easy | Med | Hard |
|-------|------|-----|------|
| `p_tox` (sharp toxic share) | 0.15 | 0.35 | 0.60 (0.50–0.75) |
| Soft contact `λ_soft` (1/s) | 0.40 | 0.32 | 0.28 |
| Soft floor `s0` | 0.75 | 0.60 | 0.50 |
| Soft reservation `ω_soft` (σ) | 2.0 | 1.4 | 1.0 |
| Sharp baseline `q0` | 0.02 | 0.02 | 0.03 |
| Pickoff gain `A_pick` | 0.6 | 1.4 | 2.6 |
| Sharp slope `b_sharp` (σ) | 0.6 | 0.45 | 0.35 |
| Sharp threshold `θ_sharp` (σ) | 0.3 | 0.1 | 0.0 |
| Toxic drift `δ_tox` (σ) | 0.8 | 1.6 | 2.6 |
| Toxic horizon `N` (ticks) | 16 | 24 | 32 |
| Size sensitivity `η` | 0.30 | 0.20 | 0.12 |
| RFQ arrival (RFQ/s) | 0.5 | 0.8 | 1.2 |
| Max pending RFQs | 3 | 5 | 8 |
| Name→toxicity transparency | full | archetype only | hidden (infer) |

Guardrail (verified in design): even on Hard a fair-width quote still fills ≈0.99 within TTL — Hard
makes flow toxic and fast, never untradeable.

### Q7. Calibration invariants (Vitest targets — see §1.7)

1. Mid-market soft fill ≥0.97 (easy/med), ≥0.95 (hard).
2. One-σ-wide fill ≈0.85/0.72/0.60 across levels, S-curve, levels ≥10pts apart.
3. Wide (3σ) fill decays toward floor (~0.55 easy → ~0.25 hard).
4. Stale quote held through a +1σ adverse move is picked off ≥0.70 on hard (cap intensity so it lands
   0.70–0.85, not 1.0), ≤0.35 on easy.
5. Toxic break-even width `w_be ≈ δ_tox·σ_M/2`: quoting tighter than `w_be` to a sharp/toxic name is
   mean-negative across seeds.
6. `E[PnL | hold to TTL] < E[PnL | refresh at e≥0]` on med/hard (the staleness lesson).
7. A–S bot > strawman on identical seeds, margin widening with difficulty.
8. P&L identity reconciles to 1e−9.
9. Determinism + stream-isolation (a never-filled extra quote shifts no other draw).
10. Fixed mediocre policy: mean PnL strictly decreases easy→med→hard, mean adverse-selection strictly
    increases.
11. **(Phase 1b emergent book)** observed half-spread & depth land in target bands per difficulty; no
    persistent crossed book; sustained one-sided student flow reduces hit-side depth (MM quote-pull)
    and it heals after flow stops.

### Q8. Engine build order (within Phase 1)

`rng` + determinism tests → `price` (single asset) → **single-venue 1a parametric book** +
walk-the-book hedge + `pnl` decomposition → `quote` lifecycle + `fill` hazard (single soft client) →
client archetypes + toxic flow + attribution → multi-venue + resilience + toxicity reaction → `rfq`
arrivals + `maxPendingRFQs` → difficulty presets → calibration test suite (Q7) → **Phase 1b: swap in
agent-MM matching LOB (`maker.js` + `match.js`) behind the `book` interface, retaining the parametric
book as a test double.** UI and grading layer follow.

---

## Phase 2 — Telegram-style UI (scoped; built after engine)

React terminal mirroring the instructor's screenshot. **Left:** chat list of named clients/avatars,
unread badges, newest RFQ on top. **Right:** active conversation — client bubble "Looking for a
two-way on $X of [ASSET]", student types `bid / ask` into the composer; the quote shows as a sent
bubble with a **live TTL countdown** and an "off"/refresh control. Background market keeps moving
(price/book panel + a running mid), so a stale live quote visibly ages. Supporting panels: order books
(multi-venue ladders), hedge controls (clip-size buttons + venue/split + market), blotter/positions,
P&L decomposition, clock/session. Crypto-native, retro-terminal-meets-Telegram aesthetic; keyboard-
first. The `maxPendingRFQs` cap keeps at most N conversations awaiting a quote so students aren't
overwhelmed. Engine API from §1.6 already supports concurrent named conversations + live-quote state.

---

## Phase 3 — Grading scorecard (scoped; built last)

The benchmark-relative balanced scorecard is already designed (see the agent design doc referenced in
this plan's sibling file). Summary of what gets built later: pure `/engine/scoring.js`,
`/engine/benchmarks.js` (B0 strawman + Avellaneda–Stoikov optimal, optional B1 competent, re-run on
the **identical seed/path** via `runFromSeed`), `/engine/markouts.js`, `/engine/scoringConfig.js`, and
`/ui/report.js`. Seven tensioned axes (hedging quality, inventory discipline, adverse-selection
avoidance, spread-capture-net, risk-adjusted P&L via Sortino, market presence, tail behavior) +
participation gate; each metric scored 0–100 by interpolation between strawman-floor and optimal-
ceiling on that path, neutralizing path luck. Runs client-side at session end (the report IS the grade
artifact) with an optional offline Node instructor replay tool. The engine's only obligation to make
this possible — fully sub-streamed seeded RNG, a complete replayable event log, and `runFromSeed` — is
already baked into Phase 1.

---

## Verification (end-to-end)

1. **Bootstrap:** repo exists on GitHub (public), `npm install` + `npm run dev` serves locally, Pages
   URL loads with `?seed=` working.
2. **Engine:** `npm test` green; determinism test passes; the staleness unit test demonstrates a
   picked-off stale quote producing the expected adverse-selection loss; difficulty presets verifiably
   change `p_tox`, `β`, pickoff aggression, and `maxPendingRFQs`.
3. **Manual playtest (post-UI):** run a 20-min Easy session — confirm RFQs from named clients arrive,
   a two-way can be streamed, the live TTL counts down, leaving a quote up during an adverse move gets
   picked off by a sharp client, refreshing avoids it, hedging into the book shows impact + slippage in
   the P&L decomposition, and the pending-RFQ cap holds. Repeat on Hard to confirm toxic flow drifts
   against tight quotes while well-priced quotes still trade.
4. **Reproducibility:** replay a recorded `(seed, config, actions)` and confirm an identical event log
   (the property the future grader depends on).

## Out of scope for this plan
Phase 1.5 engine extras (passive/limit hedging, order splitting/routing, all four scenarios), the
options-OTC layer (Phase 2 of the broader project — reuses `book`/`price`/`impact`), and any
curriculum/LaTeX changes (explicitly untouched).
