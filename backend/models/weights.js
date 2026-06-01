/**
 * Default ("prior") scoring weights per risk level, plus loader for tuned
 * weights produced by the backtesting tuner.
 *
 * These priors encode value-investing judgment that matches the brief:
 *   - Conservative: balance sheet, interest coverage, earnings consistency,
 *     margin stability, valuation discipline dominate.
 *   - Aggressive: ROIC, FCF growth, owner-earnings expansion get more weight,
 *     with looser (not absent) valuation discipline and still-meaningful debt/
 *     dilution guardrails.
 *   - Moderate: a balanced blend.
 *
 * The tuner searches AROUND these priors (constrained), so the final weights
 * remain economically sensible rather than overfit artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const METRIC_KEYS = [
  'roic',
  'fcfGrowth',
  'ownerEarnings',
  'marginStability',
  'debt',
  'interestCoverage',
  'earningsConsistency',
  'shareCount',
  'roe',
  'valuation',
];

export const DEFAULT_WEIGHTS = {
  conservative: {
    roic: 0.1,
    fcfGrowth: 0.06,
    ownerEarnings: 0.06,
    marginStability: 0.12,
    debt: 0.16,
    interestCoverage: 0.14,
    earningsConsistency: 0.14,
    shareCount: 0.08,
    roe: 0.06,
    valuation: 0.08,
  },
  moderate: {
    roic: 0.13,
    fcfGrowth: 0.11,
    ownerEarnings: 0.1,
    marginStability: 0.09,
    debt: 0.11,
    interestCoverage: 0.09,
    earningsConsistency: 0.1,
    shareCount: 0.07,
    roe: 0.08,
    valuation: 0.12,
  },
  aggressive: {
    roic: 0.17,
    fcfGrowth: 0.17,
    ownerEarnings: 0.14,
    marginStability: 0.06,
    debt: 0.08,
    interestCoverage: 0.06,
    earningsConsistency: 0.07,
    shareCount: 0.05,
    roe: 0.1,
    valuation: 0.1,
  },
};

// Recommended rebalancing defaults; refined by the backtester and overwritten in
// the tuned file when available.
export const DEFAULT_REBALANCING = {
  conservative: 'annual',
  moderate: 'semiannual',
  aggressive: 'quarterly',
};

const TUNED_PATH = path.join(config.paths.data, 'tuned_weights.json');

let cachedTuned = null;

/**
 * Load tuned weights from data/tuned_weights.json if present, else fall back to
 * the priors. Returns { weights, rebalancing, meta }.
 */
export function loadWeights() {
  if (cachedTuned) return cachedTuned;
  try {
    if (fs.existsSync(TUNED_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TUNED_PATH, 'utf8'));
      cachedTuned = {
        weights: parsed.weights || DEFAULT_WEIGHTS,
        rebalancing: parsed.rebalancing || DEFAULT_REBALANCING,
        meta: parsed.meta || { source: 'tuned' },
      };
      logger.info('Loaded tuned weights from data/tuned_weights.json');
      return cachedTuned;
    }
  } catch (err) {
    logger.warn(`Could not load tuned weights, using priors: ${err.message}`);
  }
  cachedTuned = {
    weights: DEFAULT_WEIGHTS,
    rebalancing: DEFAULT_REBALANCING,
    meta: { source: 'default-priors', note: 'Run `npm run tune` to generate tuned weights.' },
  };
  return cachedTuned;
}

/** Normalize a weight map to sum to 1 (defensive against hand-edits). */
export function normalizeWeights(w) {
  const total = METRIC_KEYS.reduce((s, k) => s + (w[k] || 0), 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS.moderate };
  const out = {};
  for (const k of METRIC_KEYS) out[k] = (w[k] || 0) / total;
  return out;
}

/** Clear the in-memory cache (used after the tuner writes new weights). */
export function invalidateWeightsCache() {
  cachedTuned = null;
}
