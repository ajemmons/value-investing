/**
 * Precompute the full-universe 12-stock portfolio for each risk level and write
 * committed JSON the live site can serve instantly (no SEC load per request).
 *
 *   npm run precompute            # all three risk levels, full universe
 *
 * Run this with a WARM cache (after `npm run fetch-universe` and at least one
 * full build), then commit data/precomputed/*.json and push to redeploy.
 */
import { logger } from '../utils/logger.js';
import { analyzeTicker } from '../services/analyzer.js';
import { mapLimit } from '../utils/concurrency.js';
import { resolveUniverse, hasFullUniverse } from '../services/universe.js';
import { buildPortfolioResponse } from '../services/portfolioBuilder.js';
import { savePrecomputedPortfolio } from '../services/precomputed.js';

const RISK_LEVELS = ['conservative', 'moderate', 'aggressive'];

async function main() {
  if (!hasFullUniverse()) {
    logger.warn('No full universe at data/universe/russell1000.json — run `npm run fetch-universe` first. Using the built-in subset.');
  }
  const { tickers, meta } = resolveUniverse({ full: true });
  logger.info(`Precomputing portfolios from "${meta.name}" (${tickers.length} tickers)…`);

  for (const riskLevel of RISK_LEVELS) {
    const t0 = Date.now();
    const results = await mapLimit(tickers, 6, (t) => analyzeTicker(t, riskLevel));
    // Precompute a larger ranked list (top 25) so the live site can serve any
    // user-chosen size up to 25 instantly by slicing — see slicePortfolioResponse.
    const response = buildPortfolioResponse(results, { riskLevel, size: 25, perSector: 3, universeMeta: meta });
    response.precomputed = true;
    response.generatedAt = new Date().toISOString();
    savePrecomputedPortfolio(riskLevel, response);
    logger.info(
      `  ${riskLevel}: ${response.portfolio.map((p) => p.ticker).join(', ')} ` +
        `(avg ${response.avgScore}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
  }
  logger.info('Done. Commit data/precomputed/*.json and push to deploy.');
}

main().catch((err) => {
  logger.error('precompute failed:', err);
  process.exit(1);
});
