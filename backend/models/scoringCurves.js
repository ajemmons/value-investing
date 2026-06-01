/**
 * Per-metric scoring curves.
 *
 * Each curve maps a raw financial metric to a 0-100 sub-score via piecewise-
 * linear interpolation over researched anchor points. Anchors encode value-
 * investing judgment (e.g. ROIC > 20% is "excellent", D/E > 2 is "dangerous").
 *
 * Returning a structured result ({ score, value, label, note }) keeps scoring
 * transparent — the UI shows exactly why each metric earned its points.
 *
 * `null` value => metric unavailable (score null); the aggregator renormalizes
 * weights across available metrics instead of penalizing missing data.
 */
import { isNum } from '../utils/validation.js';

/**
 * Piecewise-linear interpolation. `anchors` is an array of [x, score] sorted by
 * x ascending. For "higher is better" metrics, score rises with x; for "lower is
 * better", provide descending scores. Values outside the range clamp.
 */
function interp(value, anchors) {
  if (!isNum(value)) return null;
  if (value <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, s0] = anchors[i];
    const [x1, s1] = anchors[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return s0 + t * (s1 - s0);
    }
  }
  return last[1];
}

function label(score) {
  if (score === null) return 'N/A';
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  if (score >= 30) return 'Weak';
  return 'Poor';
}

const pct = (x) => (isNum(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const num = (x, d = 2) => (isNum(x) ? x.toFixed(d) : x === Infinity ? '∞' : 'n/a');

/** Wrap a raw score with metadata. */
function result(score, value, note) {
  return { score: score === null ? null : Math.round(score), value, label: label(score), note };
}

// ---------------------------------------------------------------------------
// Individual metric curves. Each takes the financialModel `metrics` object.
// ---------------------------------------------------------------------------

export const curves = {
  // 1. ROIC — blend latest (70%) and average (30%) to reward durability.
  roic(m) {
    const blended = blend(m.roicLatest, m.roicAvg, 0.7);
    const s = interp(blended, [
      [-0.05, 0],
      [0.05, 35],
      [0.1, 55],
      [0.15, 75],
      [0.2, 90],
      [0.3, 100],
    ]);
    return result(s, blended, `ROIC ${pct(blended)} (latest ${pct(m.roicLatest)}, avg ${pct(m.roicAvg)})`);
  },

  // 2. Free cash flow growth — CAGR gated by positivity of FCF history.
  fcfGrowth(m) {
    let s = interp(m.fcfCagr, [
      [-0.1, 10],
      [0, 40],
      [0.05, 60],
      [0.1, 78],
      [0.15, 90],
      [0.25, 100],
    ]);
    // If FCF was frequently negative, cap the score — growth off a shaky base.
    if (isNum(m.fcfPositiveRatio) && s !== null) {
      s = Math.min(s, 30 + 70 * m.fcfPositiveRatio);
    }
    return result(
      s,
      m.fcfCagr,
      `FCF CAGR ${pct(m.fcfCagr)}, positive in ${pct(m.fcfPositiveRatio)} of years`,
    );
  },

  // 3. Owner earnings growth (Buffett's preferred earnings proxy).
  ownerEarnings(m) {
    let s = interp(m.ownerEarningsCagr, [
      [-0.1, 15],
      [0, 45],
      [0.05, 62],
      [0.1, 80],
      [0.2, 100],
    ]);
    if (s !== null && isNum(m.ownerEarningsLatest) && m.ownerEarningsLatest <= 0) {
      s = Math.min(s, 30); // negative owner earnings is a red flag regardless of growth
    }
    return result(s, m.ownerEarningsCagr, `Owner earnings CAGR ${pct(m.ownerEarningsCagr)}`);
  },

  // 4. Operating margin stability — low coefficient of variation is best, with
  //    a bonus for structurally high margins.
  marginStability(m) {
    let s = interp(m.operatingMarginCoeffVar, [
      [0.05, 100],
      [0.15, 85],
      [0.3, 65],
      [0.5, 45],
      [1.0, 20],
      [2.0, 5],
    ]);
    // Reward genuinely high average margins (pricing power / moat signal).
    if (s !== null && isNum(m.operatingMarginAvg)) {
      const bonus = interp(m.operatingMarginAvg, [
        [0, -10],
        [0.1, 0],
        [0.2, 6],
        [0.35, 12],
      ]);
      s = Math.max(0, Math.min(100, s + (bonus || 0)));
    }
    return result(
      s,
      m.operatingMarginCoeffVar,
      `Avg margin ${pct(m.operatingMarginAvg)}, variability ${num(m.operatingMarginCoeffVar)}`,
    );
  },

  // 5. Debt levels — combine D/E and net-debt/EBITDA (whichever is worse drives).
  debt(m) {
    const deScore = interp(m.debtToEquityLatest, [
      [0, 100],
      [0.3, 90],
      [0.6, 75],
      [1.0, 55],
      [2.0, 25],
      [4.0, 5],
    ]);
    const ndeScore = interp(m.netDebtToEbitdaLatest, [
      [-1, 100], // net cash
      [0, 95],
      [1, 85],
      [2, 70],
      [3, 50],
      [5, 20],
      [7, 5],
    ]);
    let s;
    if (deScore === null && ndeScore === null) s = null;
    else if (deScore === null) s = ndeScore;
    else if (ndeScore === null) s = deScore;
    else s = 0.5 * deScore + 0.5 * ndeScore;
    return result(
      s,
      m.debtToEquityLatest,
      `D/E ${num(m.debtToEquityLatest)}, Net debt/EBITDA ${num(m.netDebtToEbitdaLatest)}`,
    );
  },

  // 6. Interest coverage — EBIT / interest.
  interestCoverage(m) {
    const v = m.interestCoverageLatest;
    if (v === Infinity)
      return result(100, Infinity, 'No meaningful interest expense (effectively unlevered)');
    const s = interp(v, [
      [0, 0],
      [1.5, 25],
      [3, 50],
      [6, 72],
      [12, 90],
      [20, 100],
    ]);
    return result(s, v, `Interest coverage ${num(v, 1)}x`);
  },

  // 7. Earnings consistency — positive-year ratio plus steady revenue.
  earningsConsistency(m) {
    let s = interp(m.earningsPositiveRatio, [
      [0.4, 10],
      [0.6, 35],
      [0.8, 65],
      [0.9, 82],
      [1.0, 100],
    ]);
    if (s !== null && isNum(m.revenueCagr)) {
      // Mild reward for steady top-line growth; penalty for shrinking revenue.
      const adj = interp(m.revenueCagr, [
        [-0.1, -12],
        [0, 0],
        [0.05, 4],
        [0.15, 8],
      ]);
      s = Math.max(0, Math.min(100, s + (adj || 0)));
    }
    return result(
      s,
      m.earningsPositiveRatio,
      `Profitable in ${pct(m.earningsPositiveRatio)} of years, revenue CAGR ${pct(m.revenueCagr)}`,
    );
  },

  // 8. Share count trend — buybacks (negative trend) good, dilution bad.
  shareCount(m) {
    // trend is fractional change per year; negate so "reduction" scores high.
    const reduction = isNum(m.shareCountTrend) ? -m.shareCountTrend : null;
    const s = interp(reduction, [
      [-0.05, 5], // issuing 5%/yr -> heavy dilution
      [-0.02, 30],
      [0, 60],
      [0.01, 78],
      [0.03, 95],
      [0.05, 100],
    ]);
    const dir =
      m.shareCountTrend === null
        ? 'unknown'
        : m.shareCountTrend < -0.005
          ? 'reducing (buybacks)'
          : m.shareCountTrend > 0.005
            ? 'rising (dilution)'
            : 'stable';
    return result(s, m.shareCountTrend, `Share count ${dir} (${pct(m.shareCountTrend)}/yr)`);
  },

  // 9. Return on equity — blend latest/average; high ROE rewarded but capped to
  //    avoid over-rewarding leverage-driven ROE (debt is scored separately).
  roe(m) {
    const blended = blend(m.roeLatest, m.roeAvg, 0.6);
    const s = interp(blended, [
      [-0.05, 0],
      [0.05, 35],
      [0.1, 55],
      [0.15, 75],
      [0.2, 90],
      [0.3, 100],
    ]);
    return result(s, blended, `ROE ${pct(blended)} (latest ${pct(m.roeLatest)}, avg ${pct(m.roeAvg)})`);
  },

  // 10. Valuation vs intrinsic value — driven by margin of safety from the DCF.
  //     Provided separately because it depends on price + valuation module.
  valuation(marginOfSafety, peContext) {
    let s = interp(marginOfSafety, [
      [-0.5, 5], // 50% overvalued
      [-0.2, 25],
      [0, 50],
      [0.2, 72],
      [0.4, 90],
      [0.6, 100],
    ]);
    // Contextual P/E nudge (never a standalone reward/penalty): if a stock looks
    // cheap on MoS but P/E is far above peers without growth/quality support,
    // trim; if cheap P/E aligns with quality, small boost.
    if (s !== null && peContext && isNum(peContext.adjustment)) {
      s = Math.max(0, Math.min(100, s + peContext.adjustment));
    }
    const note = isNum(marginOfSafety)
      ? `Margin of safety ${pct(marginOfSafety)}${peContext?.summary ? ` · ${peContext.summary}` : ''}`
      : 'Valuation unavailable (no price or insufficient cash-flow data)';
    return result(s, marginOfSafety, note);
  },
};

/** Blend two values with weight w on the first; tolerate nulls. */
function blend(a, b, w) {
  if (isNum(a) && isNum(b)) return w * a + (1 - w) * b;
  if (isNum(a)) return a;
  if (isNum(b)) return b;
  return null;
}

export { label as scoreLabel };
