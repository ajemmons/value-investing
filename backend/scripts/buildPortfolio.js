/**
 * Build a portfolio from the command line — the practical way to run the FULL
 * Russell 1000 without a browser request timing out. It evaluates every name
 * (with bounded concurrency + progress), which also PRE-WARMS the disk cache so
 * the website's "Use full Russell 1000" build is fast afterward.
 *
 *   npm run portfolio -- --full --risk moderate
 *   npm run portfolio -- --risk conservative --size 12 --perSector 3
 *   npm run portfolio -- --full --risk aggressive --concurrency 6
 *
 * Writes data/backtest_results/portfolio_<risk>.json and prints the holdings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { analyzeTicker } from '../services/analyzer.js';
import { mapLimit } from '../utils/concurrency.js';
import { selectPortfolio } from '../models/portfolio.js';
import { resolveUniverse, hasFullUniverse } from '../services/universe.js';

function parseArgs(argv) {
  const a = { risk: 'moderate', size: 12, perSector: 3, full: false, concurrency: 3 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--full') a.full = true;
    else if (k === '--risk') a.risk = argv[++i];
    else if (k === '--size') a.size = parseInt(argv[++i], 10);
    else if (k === '--perSector') a.perSector = parseInt(argv[++i], 10);
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.full && !hasFullUniverse()) {
    logger.warn('No full universe found at data/universe/russell1000.json — run `npm run fetch-universe` first. Falling back to the built-in subset.');
  }
  const { tickers, meta } = resolveUniverse({ full: args.full });
  logger.info(`Evaluating ${tickers.length} tickers from "${meta.name}" for a ${args.risk} investor (concurrency ${args.concurrency})…`);

  const t0 = Date.now();
  let done = 0;
  const results = await mapLimit(tickers, args.concurrency, async (t) => {
    const r = await analyzeTicker(t, args.risk);
    done += 1;
    if (done % 25 === 0 || done === tickers.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      logger.info(`  ${done}/${tickers.length} evaluated (${rate.toFixed(1)}/s)`);
    }
    return r;
  });

  const ok = results.filter((r) => r.ok).length;
  const pick = selectPortfolio(results, { riskLevel: args.risk, size: args.size, perSector: args.perSector });

  console.log(`\n=== ${args.risk.toUpperCase()} — top ${pick.selected.length} (max ${args.perSector}/sector) ===`);
  console.log('rank  ticker  score  rating       sector');
  pick.selected.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}.   ${r.ticker.padEnd(7)} ${String(r.score).padStart(3)}   ${(r.rating || '').padEnd(11)} ${r.sector}`,
    );
  });
  console.log(`\nEvaluated ${results.length} · scored ${ok} · failed ${results.length - ok} · took ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const out = {
    generatedAt: new Date().toISOString(),
    riskLevel: args.risk,
    universe: meta,
    evaluated: results.length,
    scored: ok,
    sectorCount: pick.sectorCount,
    portfolio: pick.selected.map((r, i) => ({
      rank: i + 1,
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      score: r.score,
      rating: r.rating,
      marginOfSafety: r.valuation?.marginOfSafety ?? null,
      price: r.price,
    })),
  };
  fs.mkdirSync(config.paths.backtestResults, { recursive: true });
  const file = path.join(config.paths.backtestResults, `portfolio_${args.risk}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  logger.info(`Wrote ${path.relative(config.paths.root, file)}. The website "Use full Russell 1000" build is now cache-warm.`);
}

main().catch((err) => {
  logger.error('buildPortfolio failed:', err);
  process.exit(1);
});
