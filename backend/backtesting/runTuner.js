/**
 * CLI: tune scoring weights for all three risk levels and write artifacts.
 *
 *   node backend/backtesting/runTuner.js   (or: npm run tune)
 *
 * Outputs:
 *   data/tuned_weights.json        -> consumed by the live scoring engine
 *   data/backtest_results/report.json -> consumed by the website dashboard
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { loadUniverse } from './syntheticData.js';
import { buildPanel } from './panel.js';
import { tuneRiskLevel } from './weightTuner.js';
import { buildRiskReport, KNOWN_LIMITATIONS } from './report.js';
import { invalidateWeightsCache } from '../models/weights.js';

const RISK_LEVELS = ['conservative', 'moderate', 'aggressive'];

async function main() {
  const t0 = Date.now();
  logger.info('Loading historical universe...');
  const universe = loadUniverse();
  logger.info(`Universe: ${universe.companies.length} companies, outcomes:`, universe.meta.outcomeCounts);

  logger.info('Building point-in-time scoring panel (this reuses live scoring code)...');
  const panel = buildPanel(universe);
  logger.info(`Panel ready: ${panel.years.length} decision years (${panel.years[0]}-${panel.years[panel.years.length - 1]})`);

  const weights = {};
  const rebalancing = {};
  const reports = {};

  for (const risk of RISK_LEVELS) {
    logger.info(`Tuning ${risk}...`);
    const tuned = tuneRiskLevel(panel, risk, { iterations: 250 });
    weights[risk] = tuned.weights;
    rebalancing[risk] = tuned.rebalance;
    reports[risk] = buildRiskReport(panel, risk, tuned.weights, tuned.rebalance, tuned.rebalanceComparison);
    logger.info(
      `  ${risk}: rebalance=${tuned.rebalance}, fitness=${tuned.fitness.toFixed(4)}, ` +
        `annReturn=${fmtPct(reports[risk].headline.annualizedReturn)}, ` +
        `excess=${fmtPct(reports[risk].benchmark.excessAnnualized)}, ` +
        `Sharpe=${(reports[risk].headline.sharpe ?? 0).toFixed(2)}`,
    );
  }

  // Write tuned weights for the live engine.
  const tunedOut = {
    weights,
    rebalancing,
    meta: {
      source: 'tuned',
      tunedAt: new Date().toISOString(),
      dataset: universe.meta,
      note: 'Weights tuned around value-investing priors via cross-validated, bias-penalized search on illustrative data. See docs/limitations.md.',
    },
  };
  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.writeFileSync(path.join(config.paths.data, 'tuned_weights.json'), JSON.stringify(tunedOut, null, 2));
  invalidateWeightsCache();

  // Write the dashboard report.
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: universe.meta,
    benchmarks: Object.keys(universe.benchmarks),
    riskProfiles: reports,
    tunedWeights: weights,
    recommendedRebalancing: rebalancing,
    limitations: KNOWN_LIMITATIONS,
  };
  fs.mkdirSync(config.paths.backtestResults, { recursive: true });
  fs.writeFileSync(
    path.join(config.paths.backtestResults, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  logger.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  logger.info('Wrote data/tuned_weights.json and data/backtest_results/report.json');
}

function fmtPct(x) {
  return typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

main().catch((err) => {
  logger.error('Tuner failed:', err);
  process.exit(1);
});
