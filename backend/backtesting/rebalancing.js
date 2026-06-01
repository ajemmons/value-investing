/**
 * Portfolio simulator + rebalancing-method comparison.
 *
 * Given a point-in-time panel and a weight set, simulates an equal-weight,
 * top-N portfolio across a year window under different rebalancing rules and
 * returns net-of-cost annual returns plus turnover/trade diagnostics.
 *
 * Data-resolution honesty: the panel is annual, so sub-annual frequencies
 * (monthly/quarterly/semi-annual) cannot be simulated tick-by-tick. We model
 * their real-world effect through a frequency-scaled transaction-cost drag and
 * the buy-and-hold rule's deferred selling. This is documented in
 * docs/limitations.md and deliberately makes over-trading costly so the tuner
 * won't reward churn that doesn't earn its keep.
 */
import { aggregateScore } from './panel.js';
import { isNum } from '../utils/validation.js';

// Intra-year rebalance counts used to scale transaction-cost drag.
export const REBALANCE_FREQ = {
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
  buyhold: 0.34, // sells only on failure -> lowest effective churn
};

const DEFAULT_COST_RATE = 0.0015; // 15 bps per unit turnover, round-trip-ish

/**
 * Rank candidates for a decision year by aggregate score (point-in-time).
 * @returns {Array<{ticker, score, sub, sector, theme, outcome, ret, delisted}>}
 */
function rankYear(panel, weights, year, minDataComplete) {
  const out = [];
  for (const t of Object.keys(panel.byTicker)) {
    const co = panel.byTicker[t];
    const ys = co.years[year];
    if (!ys) continue;
    if (minDataComplete && !ys.dataComplete) continue;
    const score = aggregateScore(ys.sub, weights);
    if (!isNum(score)) continue;
    out.push({
      ticker: t,
      score,
      sub: ys.sub,
      sector: co.sector,
      theme: co.theme,
      outcome: co.outcome,
      ret: ys.forwardReturn,
      delisted: ys.delisted,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Simulate a portfolio.
 * @param {Object} args
 * @param {Object} args.panel
 * @param {Object} args.weights normalized weights
 * @param {number} args.startYear inclusive (holding year)
 * @param {number} args.endYear inclusive
 * @param {number} [args.topN=15]
 * @param {string} [args.rebalance='annual'] key of REBALANCE_FREQ
 * @param {number} [args.costRate]
 * @param {number} [args.exitThreshold=45] buy-and-hold sells below this score
 * @returns {Object} { returns, turnovers, trades, holdingsByYear, sectorExposure }
 */
export function simulatePortfolio({
  panel,
  weights,
  startYear,
  endYear,
  topN = 15,
  rebalance = 'annual',
  costRate = DEFAULT_COST_RATE,
  exitThreshold = 45,
}) {
  const freq = REBALANCE_FREQ[rebalance] ?? 1;
  const returns = [];
  const turnovers = [];
  const holdingsByYear = {};
  const sectorTally = {};
  let trades = 0;
  let current = new Set(); // currently held tickers

  for (let y = startYear; y <= endYear; y++) {
    const ranked = rankYear(panel, weights, y, true);
    if (!ranked.length) {
      returns.push(0);
      continue;
    }
    const rankedByTicker = Object.fromEntries(ranked.map((r) => [r.ticker, r]));
    const target = new Set(ranked.slice(0, topN).map((r) => r.ticker));

    let newHoldings;
    if (rebalance === 'buyhold') {
      // Keep holdings unless they fell below the exit threshold or delisted/gone.
      const survivors = [...current].filter((t) => {
        const r = rankedByTicker[t];
        return r && r.score >= exitThreshold && !r.delisted;
      });
      // Backfill to topN from the best names not already held.
      const fill = ranked
        .filter((r) => !survivors.includes(r.ticker))
        .slice(0, Math.max(0, topN - survivors.length))
        .map((r) => r.ticker);
      newHoldings = new Set([...survivors, ...fill]);
    } else {
      newHoldings = target;
    }

    // Turnover = fraction of the portfolio that changed names this rebalance.
    const changed = [...newHoldings].filter((t) => !current.has(t)).length;
    const denom = Math.max(newHoldings.size, 1);
    const turnover = current.size === 0 ? 1 : changed / denom;
    trades += changed;
    turnovers.push(turnover);

    // Equal-weight realized return across held names (skip names with no fwd
    // return — delisted-this-year positions realize 0 and are replaced next step).
    const held = [...newHoldings];
    const rets = held.map((t) => {
      const r = rankedByTicker[t];
      return r && isNum(r.ret) ? r.ret : 0;
    });
    const gross = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;

    // Cost drag scales with turnover AND intra-year frequency (sqrt to be sublinear).
    const costDrag = turnover * costRate * Math.sqrt(Math.max(freq, 0.34)) * freq;
    const net = gross - costDrag;
    returns.push(net);

    // Record sector exposure for concentration diagnostics.
    for (const t of held) {
      const sec = rankedByTicker[t]?.sector || 'Unknown';
      sectorTally[sec] = (sectorTally[sec] || 0) + 1;
    }
    holdingsByYear[y] = held.map((t) => ({
      ticker: t,
      score: Math.round(rankedByTicker[t].score),
      ret: rankedByTicker[t].ret,
      sector: rankedByTicker[t].sector,
      outcome: rankedByTicker[t].outcome,
    }));
    current = newHoldings;
  }

  // Normalize sector exposure to shares.
  const totalSlots = Object.values(sectorTally).reduce((a, b) => a + b, 0) || 1;
  const sectorExposure = {};
  for (const [s, c] of Object.entries(sectorTally)) sectorExposure[s] = c / totalSlots;

  return { returns, turnovers, trades, holdingsByYear, sectorExposure };
}
