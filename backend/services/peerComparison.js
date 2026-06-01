/**
 * Peer / sector-average comparison across a set of evaluated companies.
 * Computes per-sector averages of headline metrics so the UI can show how each
 * company stacks up against its peers in the analyzed group, complementing the
 * static sector baselines used in valuation.
 */
import { isNum } from '../utils/validation.js';

const COMPARE_FIELDS = ['roic', 'roe', 'operatingMarginAvg', 'fcfCagr', 'debtToEquity', 'pe'];

/**
 * @param {Array<Object>} results successful analyzeTicker results
 * @returns {Object} { bySector: { [sector]: { count, averages } }, group }
 */
export function buildPeerComparison(results) {
  const ok = results.filter((r) => r.ok);
  const bySector = {};
  const groupAcc = {};

  for (const r of ok) {
    const sec = r.sector || 'Unknown';
    const bucket = (bySector[sec] = bySector[sec] || { count: 0, acc: {} });
    bucket.count += 1;
    for (const f of COMPARE_FIELDS) {
      const v = r.metrics?.[f];
      if (isNum(v)) {
        bucket.acc[f] = bucket.acc[f] || { sum: 0, n: 0 };
        bucket.acc[f].sum += v;
        bucket.acc[f].n += 1;
        groupAcc[f] = groupAcc[f] || { sum: 0, n: 0 };
        groupAcc[f].sum += v;
        groupAcc[f].n += 1;
      }
    }
  }

  const out = {};
  for (const [sec, b] of Object.entries(bySector)) {
    const averages = {};
    for (const f of COMPARE_FIELDS) {
      averages[f] = b.acc[f] ? b.acc[f].sum / b.acc[f].n : null;
    }
    out[sec] = { count: b.count, averages };
  }
  const group = {};
  for (const f of COMPARE_FIELDS) group[f] = groupAcc[f] ? groupAcc[f].sum / groupAcc[f].n : null;

  return { bySector: out, group, fields: COMPARE_FIELDS };
}
