/**
 * Builds the backtesting dashboard report consumed by the website.
 * Aggregates per-risk-profile performance, benchmark comparison, holdings, and
 * an honest limitations section.
 */
import { runWindow, rollingWindows, RISK_PROFILES } from './engine.js';
import { annualizedReturn } from './metrics.js';

/** Build a full report for one risk profile using its tuned weights + rebalance. */
export function buildRiskReport(panel, riskLevel, weights, rebalance, rebalanceComparison) {
  const startYear = panel.years[0];
  const endYear = panel.years[panel.years.length - 1];

  const full = runWindow(panel, weights, riskLevel, { startYear, endYear, rebalance });

  // Aggregate holdings across the full span.
  const agg = {};
  for (const y of Object.keys(full.holdingsByYear)) {
    for (const h of full.holdingsByYear[y]) {
      const a = (agg[h.ticker] = agg[h.ticker] || {
        ticker: h.ticker,
        sector: h.sector,
        outcome: h.outcome,
        yearsHeld: 0,
        retSum: 0,
        retCount: 0,
      });
      a.yearsHeld += 1;
      if (typeof h.ret === 'number') {
        a.retSum += h.ret;
        a.retCount += 1;
      }
    }
  }
  const holdings = Object.values(agg).map((a) => ({
    ticker: a.ticker,
    sector: a.sector,
    outcome: a.outcome,
    yearsHeld: a.yearsHeld,
    avgReturn: a.retCount ? a.retSum / a.retCount : null,
  }));
  const ranked = holdings
    .filter((h) => h.avgReturn !== null)
    .sort((a, b) => b.avgReturn - a.avgReturn);
  const topHoldings = ranked.slice(0, 8);
  const worstHoldings = ranked.slice(-8).reverse();
  // Honest disclosure: did the model ever hold names that later failed?
  const heldFailures = holdings.filter((h) => ['bankrupt', 'decline'].includes(h.outcome));

  const windows = rollingWindows(panel.years, 8, 4).map(([s, e]) => `${s}-${e}`);

  return {
    riskLevel,
    recommendedRebalance: rebalance,
    topN: RISK_PROFILES[riskLevel].topN,
    headline: {
      annualizedReturn: full.stats.annualizedReturn,
      totalReturn: full.stats.totalReturn,
      volatility: full.stats.volatility,
      maxDrawdown: full.stats.maxDrawdown,
      sharpe: full.stats.sharpe,
      sortino: full.stats.sortino,
      winRate: full.stats.winRate,
      avgTurnover: full.stats.avgTurnover,
      trades: full.stats.trades,
    },
    benchmark: {
      sp500Annualized: full.benchmarkAnnualized,
      excessAnnualized: full.excessAnnualized,
    },
    sectorExposure: full.sectorExposure,
    winnerRelianceShare: full.relianceShare,
    penalties: full.penalties,
    topHoldings,
    worstHoldings,
    heldFailuresCount: heldFailures.length,
    periodsTested: windows,
    rebalanceComparison,
  };
}

export const KNOWN_LIMITATIONS = [
  'Backtest runs on ILLUSTRATIVE synthetic data, not real market history. Results demonstrate the engine and weighting logic; they are NOT evidence of real-world performance.',
  'The synthetic market models real, adversarial dynamics — factor-regime shifts (quality/value premia go negative in junk rallies), P/E multiple expansion/compression, fat-tailed mega-winners, sudden fundamentals-independent blowups, and sector rotation under a shared macro/rate cycle — so the strategy realistically LOSES in some years and some windows rather than winning by construction.',
  'Benchmarks are cap-weighted and derived from the universe itself, so failures shrink out and winners dominate — a deliberately harder bar than equal-weighting.',
  'Even so, the synthetic failure rate is higher than a real index, so the screen’s loss-avoidance edge is somewhat flattered; read the magnitude of outperformance with skepticism and focus on the CHARACTER (crash defense, lagging in growth/junk rallies, regime dependence).',
  'Survivorship bias is mitigated (the universe deliberately includes bankruptcies, declines, mergers, and blowups) but real point-in-time index membership and delisted-company financials are not modeled.',
  'Price data resolution is annual, so sub-annual rebalancing (monthly/quarterly) is approximated via frequency-scaled cost drag, not tick-by-tick simulation.',
  'A fixed ~2-year fundamentals availability lag is assumed to avoid look-ahead bias; real filing timing varies.',
  'Transaction costs, taxes, slippage, and liquidity are modeled simply and may understate real frictions.',
  'Tuned weights are anchored to value-investing priors and cross-validated across rolling windows to limit overfitting, but any optimization on a single dataset carries overfitting risk.',
  'Drop a real, bias-controlled universe into data/historical/ to run the identical engine on actual history.',
];
