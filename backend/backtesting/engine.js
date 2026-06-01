/**
 * Backtesting engine.
 *
 * Evaluates a weight set for a risk level across MULTIPLE rolling time windows
 * (cross-validation against overfitting and bull-market-only optimization),
 * compares to benchmarks, applies bias-control penalties, and reduces everything
 * to a single risk-specific `fitness` the tuner maximizes — plus a rich report
 * for the dashboard.
 */
import { simulatePortfolio, REBALANCE_FREQ } from './rebalancing.js';
import {
  totalReturn,
  annualizedReturn,
  volatility,
  maxDrawdown,
  sharpe,
  sortino,
  winRate,
  avgTurnover,
} from './metrics.js';
import {
  sectorConcentrationPenalty,
  famousWinnerReliancePenalty,
  turnoverPenalty,
  drawdownPenalty,
} from './biasControls.js';
import { isNum } from '../utils/validation.js';

// Risk-specific simulation + objective configuration.
export const RISK_PROFILES = {
  conservative: {
    topN: 22,
    drawdownIntensity: 1.6,
    turnoverIntensity: 1.6,
    wAnnReturn: 0.25,
    wSharpe: 0.45,
    wExcess: 0.3,
    preferredRebalance: ['annual', 'buyhold', 'semiannual'],
  },
  moderate: {
    topN: 16,
    drawdownIntensity: 1.1,
    turnoverIntensity: 1.0,
    wAnnReturn: 0.35,
    wSharpe: 0.4,
    wExcess: 0.25,
    preferredRebalance: ['annual', 'semiannual', 'quarterly'],
  },
  aggressive: {
    topN: 12,
    drawdownIntensity: 0.8,
    turnoverIntensity: 0.7,
    wAnnReturn: 0.5,
    wSharpe: 0.35,
    wExcess: 0.15,
    preferredRebalance: ['quarterly', 'semiannual', 'monthly', 'annual'],
  },
};

/** Generate rolling [start,end] windows over a sorted year list. */
export function rollingWindows(years, size, step) {
  const out = [];
  const min = years[0];
  const max = years[years.length - 1];
  for (let s = min; s + size - 1 <= max; s += step) {
    out.push([s, s + size - 1]);
  }
  // Always include the full span as one window for an "all-period" view.
  if (!out.some(([a, b]) => a === min && b === max)) out.push([min, max]);
  return out;
}

/** Benchmark (S&P 500) annual returns restricted to a window. */
function benchmarkReturns(panel, startYear, endYear) {
  const bm = panel.benchmarks?.SP500 || [];
  return bm.filter((b) => b.year >= startYear && b.year <= endYear).map((b) => b.return);
}

/**
 * Run a single window and return stats + penalties + per-window objective.
 */
export function runWindow(panel, weights, riskLevel, { startYear, endYear, rebalance }) {
  const profile = RISK_PROFILES[riskLevel] || RISK_PROFILES.moderate;
  const sim = simulatePortfolio({
    panel,
    weights,
    startYear,
    endYear,
    topN: profile.topN,
    rebalance,
  });

  const ppy = 1; // annual periods
  const stats = {
    totalReturn: totalReturn(sim.returns),
    annualizedReturn: annualizedReturn(sim.returns, ppy),
    volatility: volatility(sim.returns, ppy),
    maxDrawdown: maxDrawdown(sim.returns),
    sharpe: sharpe(sim.returns, ppy),
    sortino: sortino(sim.returns, ppy),
    winRate: winRate(sim.returns),
    avgTurnover: avgTurnover(sim.turnovers),
    trades: sim.trades,
  };

  const bm = benchmarkReturns(panel, startYear, endYear);
  const bmAnn = annualizedReturn(bm, ppy);
  const excess = isNum(stats.annualizedReturn) && isNum(bmAnn) ? stats.annualizedReturn - bmAnn : 0;

  const concentration = sectorConcentrationPenalty(sim.sectorExposure);
  const reliance = famousWinnerReliancePenalty(sim.holdingsByYear);
  const penalties = {
    concentration: concentration.penalty,
    winnerReliance: reliance.penalty,
    turnover: turnoverPenalty(stats.avgTurnover, profile.turnoverIntensity),
    drawdown: drawdownPenalty(stats.maxDrawdown, profile.drawdownIntensity),
  };
  const penaltyTotal = Object.values(penalties).reduce((a, b) => a + b, 0);

  const reward =
    profile.wAnnReturn * (stats.annualizedReturn || 0) +
    profile.wSharpe * 0.1 * (stats.sharpe || 0) + // scale sharpe into return-like units
    profile.wExcess * excess;

  const objective = reward - penaltyTotal;

  return {
    window: [startYear, endYear],
    rebalance,
    stats,
    benchmarkAnnualized: bmAnn,
    excessAnnualized: excess,
    penalties,
    penaltyTotal,
    objective,
    sectorExposure: sim.sectorExposure,
    relianceShare: reliance.avgTop2Share,
    holdingsByYear: sim.holdingsByYear,
  };
}

/**
 * Evaluate a weight set across all rolling windows for a risk level.
 * Fitness = mean window objective minus a stability penalty (stdev of objective)
 * so the optimizer prefers weights that work CONSISTENTLY across eras.
 */
export function evaluateWeights(panel, weights, riskLevel, { rebalance, windowSize = 8, step = 4 }) {
  const windows = rollingWindows(panel.years, windowSize, step);
  const results = windows.map(([startYear, endYear]) =>
    runWindow(panel, weights, riskLevel, { startYear, endYear, rebalance }),
  );
  const objectives = results.map((r) => r.objective).filter(isNum);
  const meanObj = objectives.reduce((a, b) => a + b, 0) / (objectives.length || 1);
  const variance =
    objectives.reduce((a, b) => a + (b - meanObj) ** 2, 0) / (objectives.length || 1);
  const stability = Math.sqrt(variance);

  // Consistency matters: subtract part of the dispersion across windows.
  const fitness = meanObj - 0.4 * stability;

  return { fitness, meanObjective: meanObj, stability, windows: results };
}
