/**
 * Portfolio construction: pick the best N companies by risk-adjusted score
 * subject to a per-sector cap. Pure and testable (no I/O).
 *
 * Risk dependency is twofold:
 *   1. The score itself is already risk-weighted (conservative vs aggressive
 *      reward different metrics), so the ranking differs by risk level.
 *   2. Risk-specific GUARDRAILS: conservative/moderate exclude "Avoid"-rated
 *      names and those with insufficient data; aggressive is permissive but still
 *      requires a real score. If guardrails would leave too few names, we fall
 *      back to the full eligible pool so a portfolio can still be built.
 */
import { isNum } from '../utils/validation.js';

/**
 * @param {Array<Object>} results analyzeTicker results (ok and failed mixed)
 * @param {Object} opts
 * @param {string} opts.riskLevel
 * @param {number} [opts.size=12]
 * @param {number} [opts.perSector=3]
 * @returns {Object} { selected, benched, sectorCount, evaluated, eligibleCount, guardrailApplied }
 */
export function selectPortfolio(results, { riskLevel = 'moderate', size = 12, perSector = 3 } = {}) {
  const eligible = results.filter((r) => r && r.ok && isNum(r.score));

  const passesGuardrail = (r) => {
    if (riskLevel === 'aggressive') return true;
    const dataOk = r.dataQuality?.sufficient !== false;
    return r.rating !== 'Avoid' && dataOk;
  };

  const guarded = eligible.filter(passesGuardrail);
  // Only enforce guardrails if they still leave enough names to fill the book.
  const guardrailApplied = guarded.length >= size;
  const pool = guardrailApplied ? guarded : eligible;

  const ranked = [...pool].sort((a, b) => b.score - a.score);

  const selected = [];
  const benched = []; // strong names passed over due to the per-sector cap
  const sectorCount = {};

  for (const r of ranked) {
    if (selected.length >= size) break;
    const sector = r.sector || 'Unknown';
    if ((sectorCount[sector] || 0) >= perSector) {
      benched.push(r);
      continue;
    }
    sectorCount[sector] = (sectorCount[sector] || 0) + 1;
    selected.push(r);
  }

  return {
    selected,
    benched,
    sectorCount,
    evaluated: results.length,
    eligibleCount: eligible.length,
    guardrailApplied,
  };
}
