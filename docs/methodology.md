# Methodology

Value Lens evaluates a company's **financial strength, business quality, valuation,
and risk-adjusted durability** in the spirit of Warren Buffett and Benjamin Graham.
It deliberately ignores price momentum, chart patterns, hype, analyst price targets,
and news sentiment.

## The ten metrics

Each metric is converted to a 0–100 sub-score by a transparent, piecewise-linear
curve (see [`backend/models/scoringCurves.js`](../backend/models/scoringCurves.js)).
Anchors encode value-investing judgment.

| # | Metric | What it measures | Why it matters |
|---|--------|------------------|----------------|
| 1 | **ROIC** | NOPAT ÷ invested capital (blend of latest + average) | The clearest sign of a durable competitive advantage |
| 2 | **Free cash flow growth** | Multi-year FCF CAGR, gated by FCF positivity | Real cash generation, not accounting earnings |
| 3 | **Owner earnings** | Net income + D&A − maintenance capex, and its growth | Buffett's preferred earnings proxy |
| 4 | **Operating margin stability** | Coefficient of variation of operating margin (+ level bonus) | Pricing power and predictable economics |
| 5 | **Debt levels** | Debt/equity **and** net-debt/EBITDA | Survivability through downturns |
| 6 | **Interest coverage** | EBIT ÷ interest expense | Ability to service debt comfortably |
| 7 | **Earnings consistency** | Share of profitable years (+ revenue trend) | Business reliability |
| 8 | **Share count trend** | Split-adjusted change in diluted shares | Buybacks reward holders; dilution erodes them |
| 9 | **Return on equity** | Net income ÷ equity (capped to avoid leverage flattery) | Capital efficiency |
| 10 | **Valuation vs intrinsic value** | Margin of safety from a DCF, nudged by contextual P/E | Price paid drives returns |

### Maintenance-capex approximation
Owner earnings need *maintenance* capex, which companies do not report separately.
We approximate it as `min(total capex, D&A)` — a conservative proxy for the capex
required to sustain the existing asset base.

### Split-adjusted share counts
Raw XBRL share counts are filed point-in-time and are **not** consistently
split-adjusted across years, so a 4:1 split looks like +300% dilution. We detect
year-over-year jumps outside `[0.71, 1.4]` as split events and neutralize them,
preserving only organic buybacks/issuance. (See `splitAdjustShares`.)

## Contextual P/E (never a standalone signal)

P/E is interpreted **only in context** — never as an automatic reward for "low" or
penalty for "high." We compare the company's P/E to its sector baseline (or live
peer average) and adjust the valuation sub-score by a **small** amount based on:

- A **low** P/E earns credit only when quality supports it (ROIC, FCF positivity,
  low debt, earnings growth) — otherwise it is flagged as a possible **value trap**.
- A **high** P/E is penalized only when growth and quality do **not** justify it
  (PEG and quality signals); a premium backed by superior economics is left alone.

See `evaluatePeContext` in [`backend/models/valuation.js`](../backend/models/valuation.js).

## Intrinsic value — two-stage DCF

We discount **owner earnings** (falling back to FCF, then net income) over a 10-year
stage-1 horizon plus a Gordon terminal value, and add net cash. Three scenarios are
produced:

- **Conservative** — growth halved, discount rate raised, terminal growth 2.0%.
- **Base** — growth dampened to 80% of historical (clamped 0–12%), risk-based discount.
- **Aggressive** — full (clamped) historical growth, slightly lower discount, 3.0% terminal.

Discount rate is risk-adjusted (conservative demands a higher return: 11% vs 10% vs 9%).
**Margin of safety** = base intrinsic per share ÷ price − 1. All assumptions are shown
in the UI.

## Risk-level weighting

The same ten sub-scores are combined with **different weights** per risk level. Missing
metrics are excluded and the remaining weights **renormalized** — never silently scored
as zero. Weights are tuned by the backtesting engine (see
[`backtesting`](../backend/backtesting/)) around value-investing priors:

- **Conservative** — balance sheet, interest coverage, earnings consistency, margin
  stability, and valuation discipline dominate; lower downside, lower dilution.
- **Moderate** — a balanced blend of quality, reasonable growth, financial strength,
  ROIC, and valuation discipline.
- **Aggressive** — more weight to ROIC, FCF growth, and owner-earnings expansion, with
  looser (but not absent) valuation discipline and still-meaningful debt/dilution guards.

The live weights are visible on the **Methodology** tab and via `GET /api/weights`.

## Ratings

| Score | Rating |
|-------|--------|
| 80–100 | Excellent |
| 65–79 | Good |
| 50–64 | Fair |
| 35–49 | Weak |
| 0–34 | Avoid |

## Diversification

When multiple companies are evaluated, the portfolio is checked for sector
concentration (max single-sector share + Herfindahl index) and flagged cyclical
themes (financials, technology, aerospace, energy, real estate). Warnings and
balancing suggestions are surfaced; highly-scoring names are not recommended blindly
if they create excessive concentration. See
[`backend/models/diversification.js`](../backend/models/diversification.js).
