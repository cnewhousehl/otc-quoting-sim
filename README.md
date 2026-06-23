# OTC Quoting Simulator (Crypto Desk)

A browser-based **spot OTC quoting simulator** that trains students to think like a market-maker on a
crypto OTC desk. Clients send RFQs over a Telegram-style chat; you stream a two-way price; the market
keeps moving while your quote sits **live**; you may get filled, take on inventory, and must hedge it
into a simulated multi-venue order book.

The lesson: the spread you quote is only your **gross edge**. Realized P&L is that spread minus the
cost of hedging your own market impact, minus adverse selection on informed flow, plus or minus
whatever inventory you warehouse — and minus whatever a sharp counterparty picks off when you leave a
price live too long.

> Teaching tool for **FINM 35600 — Institutional Crypto Markets: Liquidity and Mechanism Design**
> (University of Chicago MSFM). Fully synthetic; no real market data or firm relationships.

## Status

🚧 Early build. Repo bootstrap + scaffold are in place. The deterministic trading **engine** is built
first, then the **UI**, then the **grading scorecard**. See [`PLAN.md`](./PLAN.md) for the full design.

## Key ideas

- **Live, executable quotes with staleness risk.** A quote is live for ~30s and tradeable at that
  price even as the market drifts. Sharp clients pick off stale quotes — cancel ("off") or refresh.
- **Difficulty (Easy / Med / Hard)** rewrites a bundle of engine parameters: toxic-flow share,
  fill-vs-width sensitivity, stale-pickoff aggression, max pending RFQs, arrival rate, and how much
  client names reveal flow toxicity.
- **Named client archetypes** — sharp/toxic vs soft — that you must price differently to win flow
  and survive adverse selection.
- **Seed-deterministic.** A session is a pure function of `(seed, config, your actions)`, so it's
  reproducible and gradeable. Seed via `?seed=<id>`.

## Getting started

```bash
npm install
npm run dev        # local dev server
npm test           # engine determinism + unit tests (Vitest)
npm run build      # static bundle for GitHub Pages
```

## Layout

```
/engine    pure, headless, deterministic simulation modules (no DOM)
/config    difficulty + scenario presets, asset universe (single tunable config object)
/src       React terminal UI (Telegram-style chat + book/PnL panels)
/test      Vitest determinism + unit suites
```

## License

[MIT](./LICENSE)
