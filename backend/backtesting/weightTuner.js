/**
 * Weight tuner.
 *
 * Searches AROUND the value-investing priors (constrained random search) to find
 * weight sets that maximize the risk-specific, bias-penalized, cross-validated
 * fitness from the engine. Because the search is anchored to economically
 * sensible priors and bounded, it cannot drift into absurd overfit corners.
 *
 * It also selects the recommended rebalancing method per risk level by scoring
 * every method on the tuned weights and applying the brief's realism rules
 * (conservative favors low turnover; aggressive must JUSTIFY higher frequency
 * with better risk-adjusted results, not just higher raw return).
 */
import { DEFAULT_WEIGHTS, METRIC_KEYS, normalizeWeights } from '../models/weights.js';
import { evaluateWeights, RISK_PROFILES } from './engine.js';
import { REBALANCE_FREQ } from './rebalancing.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r());

/** Apply bounds [0.02, 0.30] then renormalize. */
function constrain(w) {
  const c = {};
  for (const k of METRIC_KEYS) c[k] = Math.min(0.3, Math.max(0.02, w[k] || 0));
  return normalizeWeights(c);
}

/** Multiplicative log-normal perturbation around a base weight map. */
function perturb(base, sigma, r) {
  const w = {};
  for (const k of METRIC_KEYS) w[k] = base[k] * Math.exp(sigma * gauss(r));
  return constrain(w);
}

/**
 * Risk-specific soft constraint: ensure the "character" of each profile is
 * preserved (e.g., conservative keeps real weight on safety metrics). Returns a
 * penalty added to nothing here — instead we reject candidates that violate it,
 * keeping the search inside sensible territory.
 */
function violatesCharacter(riskLevel, w) {
  const safety = w.debt + w.interestCoverage + w.earningsConsistency + w.marginStability;
  const growth = w.roic + w.fcfGrowth + w.ownerEarnings;
  if (riskLevel === 'conservative') return safety < 0.45 || w.valuation < 0.05;
  if (riskLevel === 'aggressive') return growth < 0.4 || w.debt < 0.04;
  if (riskLevel === 'moderate') return safety < 0.3 || growth < 0.28;
  return false;
}

/**
 * Tune one risk level.
 * @returns {{weights, rebalance, fitness, rebalanceComparison, topWindows}}
 */
export function tuneRiskLevel(panel, riskLevel, { iterations = 250, seed = 7 } = {}) {
  const r = mulberry32(seed + riskLevel.length * 1000);
  const prior = DEFAULT_WEIGHTS[riskLevel];
  const profile = RISK_PROFILES[riskLevel];
  const searchRebalance = profile.preferredRebalance[0];

  let best = {
    weights: normalizeWeights(prior),
    fitness: -Infinity,
    eval: null,
  };

  // Always evaluate the prior first.
  const candidates = [normalizeWeights(prior)];
  for (let i = 0; i < iterations; i++) {
    // Anneal the perturbation size: broad early, fine later.
    const sigma = 0.45 * (1 - i / iterations) + 0.12;
    candidates.push(perturb(prior, sigma, r));
  }

  for (const w of candidates) {
    if (violatesCharacter(riskLevel, w)) continue;
    const evalResult = evaluateWeights(panel, w, riskLevel, { rebalance: searchRebalance });
    if (evalResult.fitness > best.fitness) {
      best = { weights: w, fitness: evalResult.fitness, eval: evalResult };
    }
  }

  // Choose the rebalancing method on the tuned weights.
  const rebalanceComparison = compareRebalancing(panel, best.weights, riskLevel);
  const recommended = chooseRebalance(riskLevel, rebalanceComparison);

  return {
    weights: best.weights,
    rebalance: recommended,
    fitness: best.fitness,
    rebalanceComparison,
    topWindows: best.eval?.windows || [],
    stability: best.eval?.stability ?? null,
  };
}

/** Evaluate every rebalancing method on a fixed weight set. */
export function compareRebalancing(panel, weights, riskLevel) {
  const methods = Object.keys(REBALANCE_FREQ);
  return methods.map((rebalance) => {
    const ev = evaluateWeights(panel, weights, riskLevel, { rebalance });
    // Aggregate full-span window (last in list) for headline stats.
    const full = ev.windows[ev.windows.length - 1];
    return {
      rebalance,
      fitness: round(ev.fitness, 4),
      annualizedReturn: round(full.stats.annualizedReturn, 4),
      volatility: round(full.stats.volatility, 4),
      maxDrawdown: round(full.stats.maxDrawdown, 4),
      sharpe: round(full.stats.sharpe, 3),
      sortino: round(full.stats.sortino, 3),
      avgTurnover: round(full.stats.avgTurnover, 3),
      trades: full.stats.trades,
      excessAnnualized: round(full.excessAnnualized, 4),
    };
  });
}

/**
 * Pick the recommended rebalancing method using the SAME risk-adjusted stats the
 * dashboard displays, so the recommendation is never visibly dominated by an
 * alternative in its own table. Selection is Sharpe-first, with the brief's
 * realism rules applied as tie-breakers — not by chasing raw return:
 *   - Conservative: among methods whose Sharpe is within a small band of the
 *     best, prefer the LOWER-turnover one (tax efficiency, realism).
 *   - Aggressive: a higher-frequency method must beat annual's Sharpe by a clear
 *     margin to justify its turnover; otherwise default to annual.
 *   - Moderate: best Sharpe among annual / semi-annual / quarterly.
 */
export function chooseRebalance(riskLevel, comparison) {
  const sharpeOf = (c) => (typeof c.sharpe === 'number' ? c.sharpe : -Infinity);
  const turnOf = (c) => (typeof c.avgTurnover === 'number' ? c.avgTurnover : Infinity);
  const bySharpe = [...comparison].sort((a, b) => sharpeOf(b) - sharpeOf(a));
  const best = bySharpe[0];
  const BAND = 0.07; // Sharpe units considered "as good as" the leader

  if (riskLevel === 'conservative') {
    // Turnover-penalized Sharpe: rewards risk-adjusted return while explicitly
    // favoring low turnover (tax efficiency). Because all SCHEDULED methods share
    // the same annual selection (identical turnover, only cost-drag differs),
    // this correctly prefers ANNUAL over busier schedules, and only prefers
    // buy-and-hold when its low turnover offsets a modest Sharpe shortfall.
    const composite = (c) => sharpeOf(c) - 0.5 * turnOf(c);
    return [...comparison].sort((a, b) => composite(b) - composite(a))[0].rebalance;
  }

  if (riskLevel === 'moderate') {
    const allowed = comparison.filter((c) => ['annual', 'semiannual', 'quarterly'].includes(c.rebalance));
    allowed.sort((a, b) => sharpeOf(b) - sharpeOf(a));
    return (allowed[0] || best).rebalance;
  }

  // Aggressive: only go busier than annual if it clearly improves Sharpe.
  const annual = comparison.find((c) => c.rebalance === 'annual');
  if (annual && (sharpeOf(best) <= sharpeOf(annual) + 0.05 || best.rebalance === 'buyhold')) {
    return annual.rebalance;
  }
  return best.rebalance;
}

function round(x, d) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
