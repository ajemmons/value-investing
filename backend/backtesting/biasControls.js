/**
 * Explicit bias-control penalties applied during weight tuning and reporting.
 * These operationalize the brief's anti-bias requirements so the optimizer is
 * actively steered AWAY from degenerate solutions.
 */
import { isNum } from '../utils/validation.js';

/**
 * Sector-concentration penalty from a sector-exposure map (shares summing ~1).
 * Uses the max single-sector share and the Herfindahl index. Flagged cyclical
 * themes (financials/technology/aerospace/energy) get an extra nudge.
 * @returns {{penalty:number, maxSector:Object, hhi:number}}
 */
export function sectorConcentrationPenalty(sectorExposure) {
  const shares = Object.entries(sectorExposure || {});
  if (!shares.length) return { penalty: 0, maxSector: null, hhi: null };
  let hhi = 0;
  let max = { sector: null, share: 0 };
  for (const [sec, share] of shares) {
    hhi += share * share;
    if (share > max.share) max = { sector: sec, share };
  }
  // Penalty kicks in above a 35% single-sector share, scaling with the overage,
  // plus a smaller HHI term that punishes broad concentration.
  const overage = Math.max(0, max.share - 0.35);
  let penalty = overage * 1.2 + Math.max(0, hhi - 0.2) * 0.6;
  if (['Financials', 'Technology', 'Industrials', 'Energy & Materials'].includes(max.sector)) {
    penalty += overage * 0.4; // extra for the flagged cyclical themes
  }
  return { penalty, maxSector: max, hhi };
}

/**
 * "Famous-winner reliance" penalty. Measures how dependent the strategy's gains
 * are on a handful of extreme-return names. If most of the portfolio's positive
 * return concentrates in 1-2 holdings per year, the result is fragile and likely
 * unrepeatable (selection bias toward outliers) — so we penalize it.
 *
 * @param {Object} holdingsByYear map year -> [{ret}]
 * @returns {{penalty:number, avgTop2Share:number}}
 */
export function famousWinnerReliancePenalty(holdingsByYear) {
  const shares = [];
  for (const year of Object.keys(holdingsByYear)) {
    const rets = holdingsByYear[year].map((h) => h.ret).filter((r) => isNum(r) && r > 0);
    if (rets.length < 3) continue;
    const totalPos = rets.reduce((a, b) => a + b, 0);
    if (totalPos <= 0) continue;
    const top2 = rets.sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
    shares.push(top2 / totalPos);
  }
  if (!shares.length) return { penalty: 0, avgTop2Share: null };
  const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
  // Expected top-2 share for N>=10 equal names is modest; penalize above ~55%.
  const penalty = Math.max(0, avg - 0.55) * 1.5;
  return { penalty, avgTop2Share: avg };
}

/** Turnover penalty — discourages churn that must be justified by performance. */
export function turnoverPenalty(avgTurnover, intensity = 1) {
  if (!isNum(avgTurnover)) return 0;
  return Math.max(0, avgTurnover - 0.2) * 0.5 * intensity;
}

/** Drawdown penalty — convex in the magnitude of the worst drawdown. */
export function drawdownPenalty(maxDd, intensity = 1) {
  if (!isNum(maxDd)) return 0;
  const dd = Math.abs(maxDd);
  return Math.max(0, dd - 0.2) ** 1.3 * intensity;
}
