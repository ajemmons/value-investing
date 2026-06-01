/**
 * Pure financial math helpers.
 *
 * Every function is defensive: missing or non-finite inputs return `null`
 * ("unavailable") rather than throwing or producing misleading numbers. This is
 * deliberate — downstream scoring treats `null` as "metric unavailable" and
 * marks it as estimated/missing in the UI instead of crashing.
 */
import { isNum } from './validation.js';

/** Safe division. Returns null if denominator is ~0 or inputs are unusable. */
export function safeDiv(num, den) {
  if (!isNum(num) || !isNum(den)) return null;
  if (Math.abs(den) < 1e-9) return null;
  return num / den;
}

/** Compound annual growth rate from `begin` to `end` over `years`.
 *  Returns null if signs make CAGR meaningless (e.g. begin <= 0). */
export function cagr(begin, end, years) {
  if (!isNum(begin) || !isNum(end) || !isNum(years) || years <= 0) return null;
  if (begin <= 0 || end <= 0) return null; // CAGR undefined across zero/negative
  return Math.pow(end / begin, 1 / years) - 1;
}

/**
 * Smoothed CAGR using AVERAGED endpoints instead of single start/end years.
 *
 * A plain endpoint CAGR rests entirely on the first and last observations, so one
 * unusually high or low year at either end distorts the whole trend. This instead
 * averages the first and last `window` finite observations and computes the CAGR
 * between those two averages over the span between the windows' midpoint years —
 * which also lets the metric survive a single negative year (as long as the
 * averaged endpoints remain positive).
 *
 * @param {Array<number|null>} values series aligned with `years`
 * @param {Array<number|null>} years  fiscal years aligned with `values`
 * @param {number} [window=3] max observations to average at each end
 * @returns {number|null} annualized growth, or null if undefined (e.g. avg <= 0)
 */
export function smoothedCagr(values, years, window = 3) {
  const pairs = [];
  const vals = values || [];
  for (let i = 0; i < vals.length; i++) {
    if (isNum(vals[i]) && isNum(years?.[i])) pairs.push({ v: vals[i], y: years[i] });
  }
  if (pairs.length < 2) return null;
  // Cap the window so the head/tail slices never overlap.
  const w = Math.max(1, Math.min(window, Math.floor(pairs.length / 2)));
  const head = pairs.slice(0, w);
  const tail = pairs.slice(-w);
  const beginAvg = mean(head.map((p) => p.v));
  const endAvg = mean(tail.map((p) => p.v));
  const beginYear = mean(head.map((p) => p.y));
  const endYear = mean(tail.map((p) => p.y));
  return cagr(beginAvg, endAvg, endYear - beginYear);
}

/** Mean of an array of numbers, ignoring null/NaN. */
export function mean(arr) {
  const xs = (arr || []).filter(isNum);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation, ignoring null/NaN. */
export function stdev(arr) {
  const xs = (arr || []).filter(isNum);
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Coefficient of variation (stdev / |mean|): lower => more stable. */
export function coeffVar(arr) {
  const m = mean(arr);
  const s = stdev(arr);
  if (m === null || s === null || Math.abs(m) < 1e-9) return null;
  return s / Math.abs(m);
}

/**
 * Owner earnings (Buffett's definition, approximated from reported data):
 *   net income + depreciation/amortization + non-cash charges
 *   - maintenance capex
 * Maintenance capex is not separately reported, so we approximate it. A common,
 * conservative proxy is the lesser of total capex and D&A (the portion of capex
 * roughly needed to sustain the existing asset base).
 */
export function ownerEarnings({ netIncome, depreciationAmortization, capex }) {
  if (!isNum(netIncome)) return null;
  const da = isNum(depreciationAmortization) ? depreciationAmortization : 0;
  // capex is typically reported as a negative cash flow; use magnitude.
  const capexMag = isNum(capex) ? Math.abs(capex) : null;
  const maintCapex = capexMag === null ? da : Math.min(capexMag, da);
  return netIncome + da - maintCapex;
}

/**
 * Free cash flow = operating cash flow - capital expenditures.
 * capex passed as reported (usually negative); we subtract its magnitude.
 */
export function freeCashFlow(operatingCashFlow, capex) {
  if (!isNum(operatingCashFlow)) return null;
  const capexMag = isNum(capex) ? Math.abs(capex) : 0;
  return operatingCashFlow - capexMag;
}

/**
 * Return on invested capital.
 *   NOPAT = operating income * (1 - tax rate)
 *   Invested capital = total debt + total equity - cash & equivalents
 */
export function roic({ operatingIncome, taxRate, totalDebt, totalEquity, cash }) {
  if (!isNum(operatingIncome)) return null;
  const t = isNum(taxRate) ? Math.min(Math.max(taxRate, 0), 0.5) : 0.21;
  const nopat = operatingIncome * (1 - t);
  const debt = isNum(totalDebt) ? totalDebt : 0;
  const equity = isNum(totalEquity) ? totalEquity : 0;
  const c = isNum(cash) ? cash : 0;
  const investedCapital = debt + equity - c;
  return safeDiv(nopat, investedCapital);
}

/** Return on equity = net income / shareholders' equity. */
export function roe(netIncome, totalEquity) {
  return safeDiv(netIncome, totalEquity);
}

/** Debt-to-equity ratio. */
export function debtToEquity(totalDebt, totalEquity) {
  return safeDiv(totalDebt, totalEquity);
}

/** Net debt / EBITDA. Negative result means net cash (a good thing). */
export function netDebtToEbitda({ totalDebt, cash, ebitda }) {
  if (!isNum(totalDebt) || !isNum(ebitda)) return null;
  const netDebt = totalDebt - (isNum(cash) ? cash : 0);
  return safeDiv(netDebt, ebitda);
}

/** Interest coverage = EBIT / interest expense. */
export function interestCoverage(ebit, interestExpense) {
  if (!isNum(ebit)) return null;
  const ie = isNum(interestExpense) ? Math.abs(interestExpense) : 0;
  if (ie < 1e-9) return Infinity; // no interest expense => effectively unlimited
  return ebit / ie;
}

/** Operating margin = operating income / revenue. */
export function operatingMargin(operatingIncome, revenue) {
  return safeDiv(operatingIncome, revenue);
}

/**
 * Linear-regression slope of a series (per-step). Used to detect trends in
 * share count, margins, earnings. Returns slope normalized by mean magnitude
 * so it is comparable across companies of different sizes.
 */
export function normalizedTrend(series) {
  const xs = (series || []).filter(isNum);
  const n = xs.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = mean(xs);
  let num = 0;
  let den = 0;
  xs.forEach((y, i) => {
    num += (i - xMean) * (y - yMean);
    den += (i - xMean) ** 2;
  });
  if (Math.abs(den) < 1e-9) return null;
  const slope = num / den;
  if (Math.abs(yMean) < 1e-9) return null;
  return slope / Math.abs(yMean); // fractional change per period
}

/**
 * Split-adjust a raw share-count series so stock splits/reverse-splits don't
 * masquerade as dilution or buybacks. Raw XBRL share counts are filed
 * point-in-time and are NOT consistently split-adjusted across years, so a 4:1
 * split shows up as a +300% "share increase". We treat any year-over-year jump
 * outside [0.71, 1.4] as a split event (organic change ≈ 0 that step) and
 * preserve only the smaller, organic changes that reflect real buybacks/issuance.
 *
 * @param {Array<number|null>} series chronological share counts
 * @returns {Array<number|null>} cleaned series (same length, nulls preserved)
 */
export function splitAdjustShares(series) {
  const out = [];
  let prevRaw = null;
  let prevClean = null;
  for (const raw of series || []) {
    if (!isNum(raw)) {
      out.push(null);
      continue;
    }
    if (prevClean === null) {
      out.push(raw);
    } else {
      const ratio = raw / prevRaw;
      if (ratio > 1.4 || ratio < 0.71) {
        out.push(prevClean); // likely a split — no real economic change this step
      } else {
        out.push(prevClean * ratio); // organic buyback/issuance
      }
    }
    prevRaw = raw;
    prevClean = out[out.length - 1];
  }
  return out;
}

/** Count of periods with positive values divided by total (consistency). */
export function positiveRatio(series) {
  const xs = (series || []).filter(isNum);
  if (!xs.length) return null;
  return xs.filter((x) => x > 0).length / xs.length;
}
