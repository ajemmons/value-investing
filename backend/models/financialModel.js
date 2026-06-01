/**
 * Transforms normalized annual statements into the derived metric series the
 * scoring engine consumes. Every derived value is defensive (null = unavailable)
 * and we track which fields were estimated/missing so the UI can flag them.
 */
import {
  roic,
  roe,
  freeCashFlow,
  ownerEarnings,
  operatingMargin,
  debtToEquity,
  netDebtToEbitda,
  interestCoverage,
  smoothedCagr,
  coeffVar,
  normalizedTrend,
  positiveRatio,
  splitAdjustShares,
} from '../utils/financialMath.js';
import { isNum } from '../utils/validation.js';

/**
 * @param {Array<Object>} annual sorted ascending by fiscalYear (from secEdgar)
 * @param {Object} [opts]
 * @param {number} [opts.lookback=10] max years to consider
 * @returns {Object} derived metrics, series, and a `data quality` report
 */
export function buildFinancialModel(annual, { lookback = 10 } = {}) {
  // Use the most recent `lookback` years.
  const years = annual.slice(-lookback);
  const n = years.length;

  const series = {
    fiscalYear: years.map((y) => y.fiscalYear),
    revenue: years.map((y) => y.revenue),
    netIncome: years.map((y) => y.netIncome),
    operatingMargin: years.map((y) => operatingMargin(y.operatingIncome, y.revenue)),
    roic: years.map((y) =>
      roic({
        operatingIncome: y.operatingIncome,
        taxRate: y.taxRate,
        totalDebt: y.totalDebt,
        totalEquity: y.totalEquity,
        cash: y.cash,
      }),
    ),
    roe: years.map((y) => roe(y.netIncome, y.totalEquity)),
    fcf: years.map((y) => freeCashFlow(y.operatingCashFlow, y.capex)),
    ownerEarnings: years.map((y) =>
      ownerEarnings({
        netIncome: y.netIncome,
        depreciationAmortization: y.depreciationAmortization,
        capex: y.capex,
      }),
    ),
    debtToEquity: years.map((y) => debtToEquity(y.totalDebt, y.totalEquity)),
    netDebtToEbitda: years.map((y) =>
      netDebtToEbitda({ totalDebt: y.totalDebt, cash: y.cash, ebitda: y.ebitda }),
    ),
    interestCoverage: years.map((y) => interestCoverage(y.operatingIncome, y.interestExpense)),
    sharesOutstanding: years.map((y) => y.sharesOutstanding),
    eps: years.map((y) => y.epsDiluted),
  };

  const first = years[0] || {};
  const last = years[n - 1] || {};
  const spanYears = n > 1 ? last.fiscalYear - first.fiscalYear : 0;

  // ---- Aggregate metrics used by scoring -------------------------------------
  const metrics = {
    years: n,
    spanYears,
    latestFiscalYear: last.fiscalYear ?? null,

    // 1. ROIC — current and average
    roicLatest: lastFinite(series.roic),
    roicAvg: avgFinite(series.roic),

    // 2. Free cash flow growth — CAGR between 3-year averaged endpoints, so a
    //    single peak/trough year at either end cannot skew the trend.
    fcfCagr: smoothedCagr(series.fcf, series.fiscalYear),
    fcfPositiveRatio: positiveRatio(series.fcf),

    // 3. Owner earnings — latest and growth (averaged-endpoint CAGR)
    ownerEarningsLatest: lastFinite(series.ownerEarnings),
    ownerEarningsCagr: smoothedCagr(series.ownerEarnings, series.fiscalYear),

    // 4. Operating margin stability (lower coeff. of variation = more stable)
    operatingMarginAvg: avgFinite(series.operatingMargin),
    operatingMarginCoeffVar: coeffVar(series.operatingMargin),

    // 5. Debt levels
    debtToEquityLatest: lastFinite(series.debtToEquity),
    netDebtToEbitdaLatest: lastFinite(series.netDebtToEbitda),

    // 6. Interest coverage
    interestCoverageLatest: lastFinite(series.interestCoverage),

    // 7. Earnings consistency (positive-year ratio + revenue trend)
    earningsPositiveRatio: positiveRatio(series.netIncome),
    revenueCagr: smoothedCagr(series.revenue, series.fiscalYear),

    // 8. Share count trend (negative = buybacks = good). Split-adjusted so
    //    stock splits don't masquerade as dilution.
    shareCountTrend: normalizedTrend(splitAdjustShares(series.sharesOutstanding)),

    // 9. Return on equity
    roeLatest: lastFinite(series.roe),
    roeAvg: avgFinite(series.roe),

    // Supporting figures for valuation/PE context
    epsLatest: lastFinite(series.eps),
    netIncomeLatest: lastFinite(series.netIncome),
    fcfLatest: lastFinite(series.fcf),
    sharesLatest: lastFinite(series.sharesOutstanding),
    revenueLatest: lastFinite(series.revenue),
  };

  // ---- Data-quality report ---------------------------------------------------
  const required = [
    'roicLatest',
    'fcfCagr',
    'ownerEarningsLatest',
    'operatingMarginAvg',
    'debtToEquityLatest',
    'interestCoverageLatest',
    'earningsPositiveRatio',
    'shareCountTrend',
    'roeLatest',
  ];
  const missing = required.filter((k) => !isNum(metrics[k]) && metrics[k] !== Infinity);
  const dataQuality = {
    yearsAvailable: n,
    completeness: 1 - missing.length / required.length,
    missingMetrics: missing,
    sufficient: n >= 3 && missing.length <= 3,
  };

  return { metrics, series, dataQuality, latest: last };
}

// ---- small helpers ----------------------------------------------------------
function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i]) || arr[i] === Infinity) return arr[i];
  return null;
}
function avgFinite(arr) {
  const xs = arr.filter((x) => isNum(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
