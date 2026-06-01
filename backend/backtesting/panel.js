/**
 * Builds a point-in-time scoring panel from a historical universe.
 *
 * For every company and every decision year, we compute the 10 metric SUB-scores
 * using ONLY data that would have been available at decision time (hindsight-bias
 * control), plus the realized forward return. Sub-scores are weight-independent,
 * so the tuner can evaluate thousands of weight combinations as fast weighted
 * sums instead of re-deriving financial models each time.
 *
 * Crucially this reuses the EXACT live scoring code (buildFinancialModel,
 * valueCompany, scoringCurves) — the backtest and the website score identically.
 */
import { buildFinancialModel } from '../models/financialModel.js';
import { valueCompany } from '../models/valuation.js';
import { curves } from '../models/scoringCurves.js';
import { METRIC_KEYS } from '../models/weights.js';
import { isNum } from '../utils/validation.js';

// Data-availability lag: at the start of holding year Y we only trust financials
// through fiscal year Y-2 (the latest 10-K reliably filed by then). Conservative,
// and a firm guard against look-ahead bias.
const FISCAL_LAG = 2;

/**
 * @param {Object} universe loaded historical universe
 * @returns {Object} panel
 */
export function buildPanel(universe) {
  const companies = universe.companies || [];
  const allYears = new Set();

  const byTicker = {};
  for (const co of companies) {
    const priceByYear = {};
    for (const a of co.annual) priceByYear[a.fiscalYear] = a.price;

    const yearsAvail = co.annual.map((a) => a.fiscalYear);
    const minFy = Math.min(...yearsAvail);
    const maxFy = Math.max(...yearsAvail);

    const yearScores = {};
    // Decision years: need >=3 fiscal years of history by lag, and a decision
    // price (prior year-end) and a forward price.
    for (let y = minFy + FISCAL_LAG + 2; y <= maxFy; y++) {
      const cutoffFy = y - FISCAL_LAG;
      const history = co.annual.filter((a) => a.fiscalYear <= cutoffFy);
      if (history.length < 3) continue;

      const decisionPrice = priceByYear[y - 1];
      const forwardPrice = priceByYear[y];
      if (!isNum(decisionPrice)) continue;

      const model = buildFinancialModel(history);
      const m = model.metrics;
      const netCash = (model.latest.cash || 0) - (model.latest.totalDebt || 0);
      const valuation = valueCompany(model, {
        price: decisionPrice,
        sharesOutstanding: m.sharesLatest,
        sector: co.sector,
        netCash,
        riskLevel: 'moderate', // panel uses one discount rate; see limitations.md
      });

      const sub = {
        roic: curves.roic(m).score,
        fcfGrowth: curves.fcfGrowth(m).score,
        ownerEarnings: curves.ownerEarnings(m).score,
        marginStability: curves.marginStability(m).score,
        debt: curves.debt(m).score,
        interestCoverage: curves.interestCoverage(m).score,
        earningsConsistency: curves.earningsConsistency(m).score,
        shareCount: curves.shareCount(m).score,
        roe: curves.roe(m).score,
        valuation: curves.valuation(valuation.marginOfSafety, valuation.peContext).score,
      };

      // Forward 1-year return. If the company delisted (no forward price), the
      // realized outcome is encoded in the LAST available price move; a held
      // position that can't roll forward is treated as fully exited at decision
      // price (return 0 that year) and flagged delisted so the sim replaces it.
      const forwardReturn = isNum(forwardPrice) ? forwardPrice / decisionPrice - 1 : null;

      yearScores[y] = {
        sub,
        decisionPrice,
        forwardReturn,
        delisted: !isNum(forwardPrice),
        dataComplete: model.dataQuality.sufficient,
      };
      allYears.add(y);
    }

    byTicker[co.ticker] = {
      ticker: co.ticker,
      sector: co.sector,
      theme: co.cyclicalTheme,
      outcome: co.outcome,
      years: yearScores,
    };
  }

  return {
    byTicker,
    years: [...allYears].sort((a, b) => a - b),
    benchmarks: universe.benchmarks,
    meta: universe.meta,
    metricKeys: METRIC_KEYS,
  };
}

/** Weighted aggregate of a sub-score map given a (already-normalized) weight map. */
export function aggregateScore(sub, weights) {
  let total = 0;
  let wsum = 0;
  for (const k of METRIC_KEYS) {
    if (isNum(sub[k])) {
      total += sub[k] * weights[k];
      wsum += weights[k];
    }
  }
  if (wsum <= 0) return null;
  return total / wsum;
}
