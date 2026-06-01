# Limitations & bias controls

Read this before drawing any conclusion from the tool. **This software is for
education only and is not financial advice.**

## The single most important limitation

The bundled backtest runs on **illustrative synthetic data**, not real market
history. A genuinely survivorship-bias-free backtest requires:

1. **Point-in-time index constituents** (who was actually in the S&P 500 each year), and
2. **Full financials for companies that were delisted, went bankrupt, or merged.**

No free API provides both completely. Rather than fake real results, we generate a
deterministic universe that **deliberately includes losers** (bankruptcies, declines,
mergers, blowups, mediocre compounders) alongside winners. Its purpose is to
**exercise and validate the engine and bias controls** and to produce *plausible* weight
priors — **not** to demonstrate real-world performance.

### The synthetic market models real, adversarial dynamics

To avoid a "layup" backtest where a fundamentals strategy wins by construction, the
generator models the things that make the real market hard
([`syntheticData.js`](../backend/backtesting/syntheticData.js)):

- **Factor regime shifts** — the quality and value premia turn **negative** for stretches
  (junk rallies, growth-led runs), so the strategy underperforms in those years.
- **Multiple expansion/compression** — price = EPS × an evolving P/E that mean-reverts to
  a fundamentals-justified level but is pushed by sentiment; returns come from re-rating,
  not just earnings (so you can overpay for quality and still lose).
- **Fat-tailed mega-winners** — a few names compound at extreme rates with persistent
  multiple expansion (the power law that dominates real index returns).
- **Sudden blowups** — rare, fundamentals-independent shocks (fraud/liquidity) that a
  clean balance sheet cannot predict.
- **Sector rotation & macro** — a shared earnings/rate cycle hits sectors differently
  (energy/financials like higher rates; rich tech multiples get compressed).

Benchmarks are **cap-weighted and derived from the universe itself**, so failures shrink
out and winners dominate — a deliberately harder bar than equal-weighting.

### What the results actually show

With these dynamics, the strategy behaves like a real quality strategy: it **defends in
crashes**, **lags in junk/growth rallies**, **loses ~35–40% of individual years**, and
posts a **modest (~3–4%/yr), regime-dependent** edge — and aggressive even loses some
multi-year windows. Still, the synthetic failure rate is higher than a real index, so the
loss-avoidance edge is somewhat flattered. **Read the magnitude with skepticism and focus
on the character, not the headline outperformance.**

The same `engine`/`tuner`/`panel` code runs unchanged on real data dropped into
`data/historical/`.

## How each bias is addressed

| Bias | Mitigation in this project |
|------|---------------------------|
| **Survivorship bias** | The universe includes bankruptcies, declines, and mergers; a held name that goes bankrupt realizes its loss. The dashboard reports how many failed names the model held. |
| **Hindsight / look-ahead bias** | Scoring at decision year *Y* uses only financials filed by then (a fixed ~2-year fundamentals lag) and the prior year-end price. |
| **Overfitting** | Weights are searched **around economically sensible priors** within bounds, cross-validated across **rolling windows**, and penalized for instability across windows. |
| **Bull-market-only optimization** | Multiple overlapping windows span modeled crashes (2008/2022-style drawdowns), junk rallies, and growth-led regimes — not one bull run. The strategy underperforms in several of them. |
| **Selection bias toward famous winners** | A "winner-reliance" penalty fires when a few extreme-return names drive most of the portfolio's gains. |
| **Sector concentration bias** | A penalty on max single-sector share + Herfindahl index, with extra weight on financials/tech/aerospace/energy. |
| **Recency bias** | All windows are weighted equally; the most recent period does not dominate. |

## Data limitations

- **SEC EDGAR coverage**: US filers with XBRL data. Foreign issuers, very recent IPOs,
  and older filings may be missing or incomplete. Missing metrics are excluded and the
  remaining weights renormalized; the scorecard flags incomplete data.
- **Sector classification** uses SEC **SIC** codes mapped to coarse sectors — not GICS.
  Edge cases can be miscategorized.
- **Maintenance capex** is approximated (`min(capex, D&A)`); true maintenance capex is
  not reported.
- **Prices** come from a best-effort free endpoint unless a provider key is supplied;
  they may be delayed or occasionally unavailable, in which case valuation is skipped.

## Backtest engine limitations

- **Annual price resolution**: sub-annual rebalancing (monthly/quarterly/semi-annual)
  cannot be simulated tick-by-tick. Their real-world effect is approximated via a
  **frequency-scaled transaction-cost drag** plus the buy-and-hold rule's deferred
  selling. This makes over-trading costly so the tuner won't reward churn that doesn't
  improve risk-adjusted returns — but it is an approximation.
- **Costs/taxes/slippage/liquidity** are modeled simply and likely understate real
  frictions.
- **Single dataset**: any optimization on one dataset carries overfitting risk, even
  with cross-validation and priors.

## Intrinsic value limitations

DCF output is highly sensitive to growth, discount-rate, and terminal-growth
assumptions. The three scenarios bracket a range but are **estimates**, not forecasts.
A negative margin of safety means the model thinks the stock is expensive on its
assumptions — not a sell signal.

## Bottom line

Use Value Lens to **organize fundamental analysis transparently**, not to predict
prices. Verify every figure, understand the assumptions, and consult a licensed
professional before investing.
