/**
 * Portfolio performance statistics used across the backtester.
 * All functions tolerate short/empty series and return null when undefined.
 */
import { isNum } from '../utils/validation.js';

/** Cumulative return from a series of periodic returns (decimals). */
export function totalReturn(returns) {
  const xs = (returns || []).filter(isNum);
  if (!xs.length) return null;
  return xs.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Annualized (geometric) return given periodic returns and periods-per-year. */
export function annualizedReturn(returns, periodsPerYear) {
  const tr = totalReturn(returns);
  if (tr === null) return null;
  const nYears = returns.length / periodsPerYear;
  if (nYears <= 0) return null;
  return Math.pow(1 + tr, 1 / nYears) - 1;
}

/** Annualized volatility (stdev of periodic returns, scaled by sqrt(ppy)). */
export function volatility(returns, periodsPerYear) {
  const xs = (returns || []).filter(isNum);
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** Maximum peak-to-trough drawdown from a return series. Returns a negative #. */
export function maxDrawdown(returns) {
  const xs = (returns || []).filter(isNum);
  if (!xs.length) return null;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of xs) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Sharpe ratio (annualized) given a risk-free rate (annual decimal). */
export function sharpe(returns, periodsPerYear, riskFree = 0.03) {
  const ann = annualizedReturn(returns, periodsPerYear);
  const vol = volatility(returns, periodsPerYear);
  if (ann === null || vol === null || vol < 1e-9) return null;
  return (ann - riskFree) / vol;
}

/** Sortino ratio — like Sharpe but penalizes only downside deviation. */
export function sortino(returns, periodsPerYear, riskFree = 0.03) {
  const xs = (returns || []).filter(isNum);
  if (xs.length < 2) return null;
  const ann = annualizedReturn(returns, periodsPerYear);
  if (ann === null) return null;
  const target = riskFree / periodsPerYear;
  const downside = xs.map((r) => Math.min(0, r - target));
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / xs.length) * Math.sqrt(periodsPerYear);
  if (dd < 1e-9) return null;
  return (ann - riskFree) / dd;
}

/** Win rate: fraction of positive periods. */
export function winRate(returns) {
  const xs = (returns || []).filter(isNum);
  if (!xs.length) return null;
  return xs.filter((r) => r > 0).length / xs.length;
}

/** Average turnover from a list of per-rebalance turnover fractions. */
export function avgTurnover(turnovers) {
  const xs = (turnovers || []).filter(isNum);
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
