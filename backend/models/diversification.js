/**
 * Portfolio diversification analysis.
 *
 * Given a set of evaluated companies, measures sector concentration (count- and
 * weight-based, plus a Herfindahl-Hirschman Index) and raises warnings when the
 * selection leans too hard on one sector or on the cyclical themes the brief
 * calls out (financials, technology, aerospace, energy, real estate). Also used
 * by the backtester to penalize concentrated weight sets.
 */
import { isNum } from '../utils/validation.js';

const FLAGGED_THEMES = new Set([
  'financials',
  'technology',
  'aerospace',
  'energy',
  'real-estate',
  'automotive',
]);

/**
 * @param {Array<{ticker, sector, industry, cyclicalTheme, score}>} holdings
 * @param {Object} [opts]
 * @param {number} [opts.maxSectorShare=0.4] warn above this sector weight
 * @returns {Object} concentration metrics, warnings, and suggestions
 */
export function analyzeDiversification(holdings, { maxSectorShare = 0.4 } = {}) {
  const valid = (holdings || []).filter((h) => h && h.sector);
  const count = valid.length;
  if (count === 0) {
    return {
      count: 0,
      sectors: {},
      hhi: null,
      maxSector: null,
      warnings: ['No companies with identifiable sectors to assess diversification.'],
      suggestions: [],
      concentrated: false,
    };
  }

  // Sector tallies (equal-weight by holding count — a simple, transparent proxy).
  const sectorCounts = {};
  const themeCounts = {};
  for (const h of valid) {
    sectorCounts[h.sector] = (sectorCounts[h.sector] || 0) + 1;
    if (h.cyclicalTheme && FLAGGED_THEMES.has(h.cyclicalTheme)) {
      themeCounts[h.cyclicalTheme] = (themeCounts[h.cyclicalTheme] || 0) + 1;
    }
  }

  const sectorShares = {};
  let hhi = 0;
  for (const [sec, c] of Object.entries(sectorCounts)) {
    const share = c / count;
    sectorShares[sec] = share;
    hhi += share * share; // HHI in [1/k, 1]; higher = more concentrated
  }

  const maxSectorEntry = Object.entries(sectorShares).sort((a, b) => b[1] - a[1])[0];
  const maxSector = { sector: maxSectorEntry[0], share: maxSectorEntry[1] };

  const warnings = [];
  const suggestions = [];

  if (count >= 3 && maxSector.share > maxSectorShare) {
    warnings.push(
      `${(maxSector.share * 100).toFixed(0)}% of the selection is in ${maxSector.sector}, exceeding the ${(
        maxSectorShare * 100
      ).toFixed(0)}% concentration guideline.`,
    );
    suggestions.push(
      `Consider trimming ${maxSector.sector} exposure or adding names from underrepresented sectors.`,
    );
  }

  for (const [theme, c] of Object.entries(themeCounts)) {
    const share = c / count;
    if (count >= 3 && share >= 0.4) {
      warnings.push(
        `Heavy tilt toward the "${theme}" theme (${(share * 100).toFixed(0)}% of holdings) — a single cyclical bet raises drawdown risk.`,
      );
    }
  }

  if (count >= 3 && Object.keys(sectorCounts).length <= 2) {
    warnings.push(
      `Only ${Object.keys(sectorCounts).length} sector(s) represented — broaden across more sectors to reduce single-theme risk.`,
    );
  }

  // Constructive allocation guidance.
  const represented = new Set(Object.keys(sectorCounts));
  const desirableSpread = ['Healthcare', 'Consumer Staples', 'Industrials', 'Technology', 'Financials', 'Energy & Materials'];
  const missing = desirableSpread.filter((s) => !represented.has(s)).slice(0, 3);
  if (count >= 3 && missing.length) {
    suggestions.push(`Underrepresented sectors to consider for balance: ${missing.join(', ')}.`);
  }

  const concentrated = warnings.length > 0;

  return {
    count,
    sectors: sectorShares,
    sectorCounts,
    hhi: round(hhi, 3),
    effectiveSectors: round(1 / hhi, 2), // inverse HHI ~ "number of equivalent sectors"
    maxSector,
    themeCounts,
    warnings,
    suggestions,
    concentrated,
  };
}

function round(x, d) {
  if (!isNum(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
