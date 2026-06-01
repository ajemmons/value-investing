# API setup & configuration

Value Lens works with **zero API keys** using free SEC EDGAR data. Keys are optional
and only unlock live prices and supplemental fundamentals.

## 1. Requirements

- Node.js ≥ 18 (uses the built-in `fetch`).

## 2. Install

```bash
npm install
cp .env.example .env   # then edit .env (all values optional)
```

## 3. Configure (`.env`)

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `SEC_USER_AGENT` | Recommended | SEC's fair-access policy asks for `AppName/Version (your-email)`. |
| `PORT` | No (default 3000) | Server port. |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error`. |
| `FMP_API_KEY` | No | Financial Modeling Prep — live quotes, market cap, P/E. |
| `ALPHAVANTAGE_API_KEY` | No | Alpha Vantage — alternative price source. |
| `TIINGO_API_KEY` / `POLYGON_API_KEY` | No | Reserved for additional providers. |
| `CACHE_TTL_HOURS` | No (168) | Cache lifetime for fundamentals. |
| `PRICE_CACHE_TTL_HOURS` | No (12) | Cache lifetime for quotes. |

**Security:** API keys are read from the environment or entered in the UI for the
current session only. They are **never** hard-coded, logged, or persisted to disk by
the server, and `.env` is git-ignored.

## 4. Generate tuned weights (recommended first run)

```bash
npm run tune
```

This builds the historical panel, tunes weights for all three risk levels, and writes:

- `data/tuned_weights.json` — used by the live scoring engine.
- `data/backtest_results/report.json` — powers the Backtesting dashboard.

If you skip this step the app falls back to built-in value-investing priors.

## 5. Run

```bash
npm start          # http://localhost:3000
# or: npm run dev  # auto-restart on changes
```

## Data sources

| Source | Key needed | Used for |
|--------|-----------|----------|
| **SEC EDGAR** `company_tickers.json`, `companyfacts`, `submissions` | No | Fundamentals (multi-year XBRL), sector via SIC |
| **Financial Modeling Prep** | Yes | Live price, market cap, P/E |
| **Yahoo-compatible chart endpoint** | No | Best-effort fallback price |

All external responses are cached under `data/cached_api_data/` to respect rate limits.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness check |
| GET | `/api/config` | Which providers are configured (booleans only) |
| GET | `/api/weights` | Current scoring weights + recommended rebalancing |
| POST | `/api/analyze` | Analyze 1–25 tickers: `{ tickers, riskLevel, keys? }` |
| POST | `/api/screen` | Rank a universe (defaults to a demo list): `{ tickers?, riskLevel, keys? }` |
| GET | `/api/backtest` | Backtesting dashboard report |
| GET | `/api/validate/:ticker` | Lightweight ticker validation |

## Plugging in real historical data

Drop a file at `data/historical/sample_universe.json` matching the schema in
[`backend/backtesting/syntheticData.js`](../backend/backtesting/syntheticData.js)
(companies with point-in-time annual statements + year-end prices, benchmarks, and
outcome labels including failures). The identical engine and tuner then run on real
history. See [`limitations.md`](limitations.md).

---

## Evaluating the full Russell 1000 (all ~1,000 stocks)

By default the **12-Stock Portfolio** tab screens a representative ~195-name
large-cap subset, because SEC EDGAR doesn't publish index membership and
evaluating 1,000 companies live in one web request would time out. To use the
full index:

### 1. Load the constituent list

```bash
npm run fetch-universe
```

This downloads the holdings of the **iShares Russell 1000 ETF (IWB)** — a free,
public proxy for the index — and writes the tickers to
`data/universe/russell1000.json`.

If your network blocks iShares, download the CSV manually (ishares.com → IWB →
*Holdings* → *Download*) and pass its path:

```bash
node backend/scripts/fetchUniverse.js /path/to/IWB_holdings.csv
```

### 2. Pre-warm the cache (one time, offline)

Evaluating 1,000 names live would overwhelm a browser request, so do it once
from the command line. This fetches + caches every company's SEC data and prints
the resulting portfolio:

```bash
npm run portfolio -- --full --risk moderate
# also: --risk conservative | aggressive, --size 12, --perSector 3, --concurrency 6
```

Expect this first run to take several minutes (it's polite to SEC EDGAR). It
writes `data/backtest_results/portfolio_<risk>.json` and, crucially, fills the
disk cache.

### 3. Use it on the website

Once the list is loaded, the **"Evaluate the full Russell 1000"** checkbox appears
on the portfolio tab. Tick it and build — because the cache is warm, it completes
in roughly a minute. Re-run step 2 periodically to refresh prices/filings (the
cache TTL is governed by `CACHE_TTL_HOURS` / `PRICE_CACHE_TTL_HOURS`).

### Notes & honesty

- The IWB holdings are a **proxy** for the Russell 1000 and may differ slightly
  from the official index on any given day; membership also changes over time
  (annual reconstitution).
- A handful of names (foreign filers, recent IPOs, unusual ticker formats) lack
  clean SEC XBRL data and are skipped — the build reports how many were
  unavailable rather than failing.
- This is still a *current-universe* screen, not a point-in-time backtest. See
  [`limitations.md`](limitations.md).
