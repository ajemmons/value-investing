/**
 * Shared portfolio-response builder.
 *
 * Used by BOTH the live /api/portfolio route and the offline precompute script,
 * so the JSON shape the frontend renders is identical whether it was computed on
 * demand or served from a precomputed file.
 */
import { selectPortfolio } from '../models/portfolio.js';
import { analyzeDiversification } from '../models/diversification.js';
import { loadWeights } from '../models/weights.js';

const DISCLAIMER =
  'Educational use only. Not financial advice. A rules-based screen of a representative universe — not a recommendation to buy.';

/**
 * @param {Array<Object>} results analyzeTicker results (ok + failed mixed)
 * @param {Object} opts { riskLevel, size, perSector, universeMeta }
 * @returns {Object} the /api/portfolio response body
 */
export function buildPortfolioResponse(results, { riskLevel, size = 12, perSector = 3, universeMeta }) {
  const pick = selectPortfolio(results, { riskLevel, size, perSector });

  const slim = (r, i) => ({
    rank: i + 1,
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    industry: r.industry,
    score: r.score,
    rating: r.rating,
    marginOfSafety: r.valuation?.marginOfSafety ?? null,
    marginCapped: r.valuation?.marginCapped ?? false,
    price: r.price,
    topStrength: r.strengths?.[0]?.label ?? null,
  });

  const diversification = analyzeDiversification(
    pick.selected.map((r) => ({
      ticker: r.ticker,
      sector: r.sector,
      cyclicalTheme: r.cyclicalTheme,
      score: r.score,
    })),
    { maxSectorShare: (perSector + 0.01) / size },
  );

  const { rebalancing } = loadWeights();

  return {
    riskLevel,
    size,
    perSector,
    universe: universeMeta,
    evaluated: pick.evaluated,
    analyzed: pick.eligibleCount,
    failed: results.filter((r) => !r.ok).length,
    guardrailApplied: pick.guardrailApplied,
    portfolio: pick.selected.map(slim),
    sectorCount: pick.sectorCount,
    alternates: pick.benched.slice(0, 8).map((r) => ({
      ticker: r.ticker,
      sector: r.sector,
      score: r.score,
      rating: r.rating,
    })),
    avgScore: pick.selected.length
      ? Math.round(pick.selected.reduce((s, r) => s + r.score, 0) / pick.selected.length)
      : null,
    recommendedRebalance: rebalancing?.[riskLevel] || 'annual',
    diversification,
    disclaimer: DISCLAIMER,
  };
}
