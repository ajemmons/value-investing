/**
 * Aggregate scoring engine.
 *
 * Combines the 10 per-metric sub-scores into a single risk-adjusted score
 * (0-100), a rating bucket, and a fully transparent breakdown. Missing metrics
 * are excluded and the remaining weights are renormalized — the tool never
 * crashes on incomplete data and never silently scores a gap as zero.
 */
import { curves } from './scoringCurves.js';
import { METRIC_KEYS, normalizeWeights } from './weights.js';
import { isNum } from '../utils/validation.js';

const METRIC_LABELS = {
  roic: 'Return on Invested Capital',
  fcfGrowth: 'Free Cash Flow Growth',
  ownerEarnings: 'Owner Earnings Growth',
  marginStability: 'Operating Margin Stability',
  debt: 'Debt Levels',
  interestCoverage: 'Interest Coverage',
  earningsConsistency: 'Earnings Consistency',
  shareCount: 'Share Count Trend',
  roe: 'Return on Equity',
  valuation: 'Valuation vs Intrinsic Value',
};

function ratingFor(score) {
  if (!isNum(score)) return 'Insufficient Data';
  if (score >= 80) return 'Excellent';
  if (score >= 65) return 'Good';
  if (score >= 50) return 'Fair';
  if (score >= 35) return 'Weak';
  return 'Avoid';
}

/**
 * @param {Object} model financialModel output ({ metrics, dataQuality, ... })
 * @param {Object} valuation valueCompany output
 * @param {Object} riskWeights weight map for the chosen risk level
 * @returns {Object} { score, rating, breakdown, dataQuality, ... }
 */
export function scoreCompany(model, valuation, riskWeights) {
  const m = model.metrics;
  const weights = normalizeWeights(riskWeights);

  // Compute each metric's sub-score.
  const subScores = {
    roic: curves.roic(m),
    fcfGrowth: curves.fcfGrowth(m),
    ownerEarnings: curves.ownerEarnings(m),
    marginStability: curves.marginStability(m),
    debt: curves.debt(m),
    interestCoverage: curves.interestCoverage(m),
    earningsConsistency: curves.earningsConsistency(m),
    shareCount: curves.shareCount(m),
    roe: curves.roe(m),
    valuation: curves.valuation(valuation?.marginOfSafety ?? null, valuation?.peContext),
  };

  // Renormalize weights over the metrics that actually have a score.
  const available = METRIC_KEYS.filter((k) => isNum(subScores[k].score));
  const availWeightTotal = available.reduce((s, k) => s + weights[k], 0);

  let weighted = 0;
  const breakdown = METRIC_KEYS.map((k) => {
    const sub = subScores[k];
    const hasScore = isNum(sub.score) && availWeightTotal > 0;
    const effWeight = hasScore ? weights[k] / availWeightTotal : 0;
    const contribution = hasScore ? sub.score * effWeight : 0;
    if (hasScore) weighted += contribution;
    return {
      key: k,
      label: METRIC_LABELS[k],
      rawWeight: round(weights[k], 3),
      effectiveWeight: round(effWeight, 3),
      score: sub.score,
      rating: sub.label,
      contribution: round(contribution, 1),
      available: hasScore,
      note: sub.note,
    };
  });

  const score = available.length ? Math.round(weighted) : null;
  const rating = ratingFor(score);

  // Identify standout strengths and weaknesses for the scorecard summary.
  const scored = breakdown.filter((b) => b.available);
  const strengths = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);
  const weaknesses = [...scored].sort((a, b) => a.score - b.score).slice(0, 3);

  return {
    score,
    rating,
    breakdown,
    strengths: strengths.map((s) => ({ label: s.label, score: s.score })),
    weaknesses: weaknesses.map((w) => ({ label: w.label, score: w.score })),
    coverage: {
      metricsScored: available.length,
      metricsTotal: METRIC_KEYS.length,
      weightCovered: round(availWeightTotal, 3),
    },
    dataQuality: model.dataQuality,
  };
}

function round(x, d) {
  if (!isNum(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
