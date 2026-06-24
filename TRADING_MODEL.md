# Trading Model — audit & decisions log

This is the **single place to audit the sim's trading/economic logic**. Every
modeling choice the engine makes is recorded here with its formula, where it
lives in code, and open questions. Edit freely — this doc is meant to be argued
with. (Math/coefficients are also in `PLAN.md` Q1–Q8; this is the human-readable
"why".)

Status: engine milestones M1–M7 built. Notation: `M_t` = hidden true mid,
`σ_M` = per-tick price stdev (the unit edges are normalized by), `dt = 0.25s`,
TTL = 120 ticks = 30s.

---

## 1. Price / fair value — `engine/price.js`
- **Hidden true mid** `M_t` per asset, **never shown** to the student. They infer
  fair from the venue books. GBM with regime drift {flat, up, down, mean-revert}
  + optional Poisson jumps, Itô-corrected.
- Per-tick return = `μ_regime − ½σ² + σ·Z` (+ jump). `σ_M = M_t·σ`.
- **Attribution split**: every tick's mid move is decomposed into `r_GBM` (market
  move → inventory MtM) and `r_tox` (injected toxic drift → adverse selection).
- **Permanent-impact feedback** (`nudge`): a fraction φ of hedge impact moves `M_t`
  ("your flow is information").
- ⚠️ **To audit**: GBM vs jump-heavy crypto reality; per-asset σ values; whether
  funding rate should feed drift (perps — not modeled yet, see §7).

## 2. The venue books — `engine/book.js`, `perpVenue.js`, `amm.js`
All venues are **perpetual futures** except the DEX. Mid is venue-specific:
`m_v = M_t + basis_v + ε_v + skew(impact) + skew(toxicity)`.

**Perp order-book venues** (`perpVenue.js`):
- Parametric ladder: half-spread `s_v`, depth `D_v·exp(−k/k0)` per level, size jitter.
- **Walk-the-book VWAP** for marketable orders; **Kyle-λ permanent impact**
  `λ_v·signed/D_v`, φ fraction feeds `M_t`.
- **Tiers** (`config/venues.js`):
  - **T1** (e.g. `binance-perp`): tight (0.6 bps), deep ($400k top), tracks `M_t`,
    fast depth regrowth. → ~95% of hedging belongs here.
  - **T2** (e.g. `bybit-perp`): wider (2 bps), thinner ($100k), **mid LAGS `M_t`**
    (`lagTau=3s`) so it goes **stale** — sometimes hittable stale-cheap; slower
    regrowth (less competitive makers).
- **Resilience** (`resilience.js`): consumed depth regrows toward steady with τ_v →
  *small clips with pauses beat one sweep*.
- **Toxicity reaction** (`toxicity.js`): EWMA of your signed flow → **widen spread,
  thin the hit side, skew mid away**; heals when you stop. (Parametric now;
  becomes emergent from makers in M11.)

**DEX AMM venue** (`amm.js`):
- Constant-product **x·y=k**, reserves re-anchored to `M_t` each tick (continuous
  arb), so **slippage is exact & known**: buy VWAP `= M·Rx/(Rx−dx)·(1+fee)`.
- **Small pool** → big slippage for size; **fee acts as the spread** (30 bps).
- The **only venue for esoteric coins** (`isDexOnly`). Because the hedge venue is
  wide, those RFQs should tolerate wider pricing (wire into M8 client reservation).
- ⚠️ **To audit**: pool sizes per asset; whether to model LP depth changes / MEV;
  multi-hop routing.

## 3. Clients & fills — `engine/client.js`, `fill.js`, `config/clients.js`
- **Archetypes**: `soft` (uninformed, pays spread), `sharp` (informed, picks off),
  `mid` (blend; half the toxic share). Named invented desk handles; name→toxicity
  transparency is difficulty-gated.
- **Continuous execution hazard** per live quote, per tick:
  `h_side = λ_C · g_arch(e_side) · L(X) · R_dur(τ) · D_diff`, fill prob `1−e^{−h·dt}`.
  Edge `e` is normalized by σ_M; `e>0` = stale in-the-money to the client.
  - **Soft** `g = s0 + s1·logistic((e+ω)/b)` — high floor, trades even wide
    (spread-capture engine).
  - **Sharp** `g = q0 + A_pick·softplus((e−θ)/b)` — tiny baseline, **spikes when
    stale** (pickoff). `pickoffScale` damps it on Easy.
  - `L(X)=(X/X_ref)^{−η}` size penalty; `R_dur=1−e^{−τ/τ_react}` decision latency.
- **Competing risks**: bid-fill & ask-fill are independent; first to fire wins;
  same-tick tie → larger edge.
- ⚠️ **To audit**: are both sides of a two-way really independent hazards (a real
  client has a direction)? Currently yes — see §7 note. λ/coefficient calibration
  is M10's job (the M5/M6 values are representative, not final).

## 4. Toxic flow & adverse selection — `engine/client.js`, `price.js`, `pnl.js`
- `isToxic ~ p_tox` **sampled at RFQ creation** (keyed by rfqId), **activated on
  fill** — preserves the counterfactual ("a refreshed quote could have dodged it").
- **Post-fill drift** `μ_tox(k) = δ_tox·σ·ρ^k/Z`, front-loaded, Σ = `δ_tox·σ_M`,
  superposable across overlapping toxic fills. Sign = adverse to your new position.
- **The staleness lesson** (tested in `test/staleness.test.js`):
  - stale held quote picked off ≥0.70 (hard) / ≤0.35 (easy);
  - `E[PnL|hold] < E[PnL|refresh]` — holding a stale quote is −EV;
  - **toxic break-even width** `w_be ≈ δ_tox·σ_M/2`: quoting tighter than that to a
    sharp name is mean-negative.

## 5. P&L decomposition — `engine/pnl.js`
Exact identity (unit-tested to 1e−9), inventory marked at the **true mid**:
```
Realized = GrossSpread + InvMtM + AdvSel − HedgeSlippage − Fees
```
- **GrossSpread** edge captured filling a client vs fair at fill time.
- **HedgeSlippage** cost of hedging into a book vs fair.
- **InvMtM** warehoused-inventory MtM from `r_GBM`.
- **AdvSel** warehoused-inventory mark from `r_tox` (the toxic move).

## 6. Difficulty — `config/difficulty.js` (Q6 table)
One dial rewrites: `p_tox`, soft λ/floor/reservation, sharp q0/A_pick/θ/b,
`pickoffScale`, δ_tox/N, size η, `hazardScale`, arrival rate, maxPendingRFQs,
name transparency. Guardrail: even Hard fills a fair quote ~0.99 — toxic & fast,
not untradeable. Free tier = easy/medium; Hard + custom = licensed (`entitlements.js`).

## 7. Assumptions & open questions to audit (edit me)
- [ ] **Funding rate** (perps): not modeled. Should warehoused inventory pay/earn
      funding? Adds a carry cost to holding — relevant to the skew-vs-hedge tradeoff.
- [ ] **Internalization / quote skew** (requested lesson): you do **not** have to
      hedge immediately. If you're long, skew your two-way down to attract flow that
      flattens you — capturing spread instead of paying hedge slippage. The engine
      *supports* this (asymmetric bid/ask + independent side hazards); the value is
      emergent. **To make it land**: grading should reward internalization, and the
      UI should surface your position so you know which way to lean (positions panel).
- [ ] **Two-way hazard independence**: a soft client trading *either* side doubles
      effective fill — realistic as "equally likely to need either direction"? Or
      should each RFQ carry an intended direction?
- [ ] **Client size vs liquidity**: size coupling to book depth lands in M8.
- [ ] **Multiple assets / cross-asset hedging**: single-asset hedging for now.
- [ ] **Fees / maker rebates**: flat taker fee only; no maker/limit hedging (Phase 1.5).
- [ ] **DEX**: no MEV, no LP dynamics, no gas; arb re-anchoring is instant.
