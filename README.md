# Value Lens — Buffett / Graham Stock Evaluator

A web application that evaluates public companies using a Warren Buffett / Benjamin
Graham–style **financial-strength** methodology, adjusted by your **investing risk
level** (Conservative / Moderate / Aggressive). It includes a transparent 0–100 scoring
model, a two-stage DCF intrinsic-value estimate with a contextual P/E read, a
diversification analyzer, and a **bias-aware backtesting + weight-tuning engine**.

> ⚠️ **Educational use only — not financial advice.** The bundled backtest uses
> illustrative synthetic data. Read [`docs/limitations.md`](docs/limitations.md).

## Features

- **Risk-adjusted scoring** across 10 fundamentals: ROIC, FCF growth, owner earnings,
  operating-margin stability, debt levels, interest coverage, earnings consistency,
  share-count trend, ROE, and valuation vs intrinsic value.
- **Transparent scorecard** — every metric's sub-score, weight, contribution, and a
  plain-English note; standout strengths and weaknesses; a final rating
  (Excellent / Good / Fair / Weak / Avoid).
- **Intrinsic value** — two-stage DCF on owner earnings (base / conservative / aggressive),
  margin of safety, fully disclosed assumptions, and a **contextual P/E** that never
  rewards low or punishes high P/E in isolation.
- **Diversification warnings** — sector concentration (HHI), flagged cyclical themes,
  balancing suggestions.
- **Peer & sector averages** across the analyzed group.
- **Backtesting dashboard** — per-risk-profile returns vs S&P 500, max drawdown,
  volatility, Sharpe/Sortino, win rate, turnover, sector exposure, top/worst holdings,
  rebalancing-method comparison, and an honest limitations section.
- **Defensive throughout** — input validation, graceful handling of missing data, API
  rate-limit backoff, disk caching, and clearly marked estimates.

## Quick start

```bash
npm install
cp .env.example .env        # optional: add SEC_USER_AGENT and any provider keys
npm run tune                # tune weights + build the backtest report (recommended)
npm start                   # open http://localhost:3000
```

No API key is required — fundamentals come from free SEC EDGAR data. See
[`docs/api_setup.md`](docs/api_setup.md) for keys and provider details.

## Project structure

```
frontend/                 index.html, styles.css, app.js  (no build step)
backend/
  server.js               Express server (serves UI + API)
  api/routes.js           REST endpoints
  config/                 env-based config & key resolution (no hard-coded keys)
  services/               SEC EDGAR, market data, sector mapping, analyzer, peers
  models/                 financial model, scoring curves, weights, scoring, valuation, diversification
  backtesting/            synthetic universe, panel, rebalancing, metrics, bias controls, engine, tuner, report
  utils/                  cache, http client, logger, validation, financial math, concurrency
data/
  cached_api_data/        cached external responses
  historical/             sample (synthetic) universe — replace with real data here
  backtest_results/       generated dashboard report
docs/                     methodology.md, api_setup.md, limitations.md
```

## How scoring & tuning fit together

The **exact same** scoring code (`financialModel` → `scoringCurves` → `valuation`)
runs in both the live website and the backtester's point-in-time panel, so what you see
on a scorecard is consistent with how weights were tuned. The tuner searches **around
value-investing priors**, cross-validates across rolling windows, and applies
bias-control penalties (concentration, famous-winner reliance, turnover, drawdown)
before writing `data/tuned_weights.json`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart |
| `npm run tune` | Tune weights + generate the backtest report |
| `npm run fetch-universe` | Load the full ~1,500-name large-cap universe |
| `npm run portfolio -- --full --risk moderate` | Build a portfolio + pre-warm the cache offline |

## Deploy (live website)

This is a Node/Express app, so it needs a host that **runs Node** — GitHub Pages
will not work (it serves static files only and can't run the backend). A
[`render.yaml`](render.yaml) blueprint is included for [Render](https://render.com):

1. Push this repo to GitHub.
2. On Render: **New + → Blueprint**, select the repo (it reads `render.yaml`).
3. When prompted, set `SEC_USER_AGENT` to `value-investing/1.0 (your-email@example.com)`.
4. Deploy. You get a public URL; every push to `main` auto-redeploys.

The response cache is git-ignored, so a fresh host rebuilds it from SEC on demand
(individual analysis is instant; the first full-universe build is slower). Render's
free tier sleeps after inactivity (first request wakes it in ~30–60 s). Other Node
hosts (Railway, Fly.io) work the same way with build `npm install` / start `npm start`.

## Disclaimer

This tool is for educational purposes only and does not constitute financial,
investment, legal, or tax advice. Data may be estimated, delayed, or incomplete.
Backtests use illustrative data and do not predict future results. Always do your own
research and consult a licensed professional before investing.
