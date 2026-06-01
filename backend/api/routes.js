/**
 * REST API routes.
 *
 * All routes validate input, degrade gracefully on data problems, and never
 * leak API keys (keys arrive per-request and are used transiently only).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, resolveKeys } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { parseTickerList, normalizeTicker } from '../utils/validation.js';
import { mapLimit } from '../utils/concurrency.js';
import { analyzeTicker } from '../services/analyzer.js';
import { buildPeerComparison } from '../services/peerComparison.js';
import { analyzeDiversification } from '../models/diversification.js';
import { selectPortfolio } from '../models/portfolio.js';
import { resolveUniverse, hasFullUniverse } from '../services/universe.js';
import { loadWeights } from '../models/weights.js';

export const router = express.Router();

const VALID_RISK = new Set(['conservative', 'moderate', 'aggressive']);

function riskOf(body) {
  const r = (body?.riskLevel || 'moderate').toLowerCase();
  return VALID_RISK.has(r) ? r : 'moderate';
}

/** Health check. */
router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/** Which providers are configured (booleans only — never the keys themselves). */
router.get('/config', (_req, res) => {
  res.json({
    providers: {
      sec: true, // always available, no key
      fmp: Boolean(config.keys.fmp),
      alphaVantage: Boolean(config.keys.alphaVantage),
      tiingo: Boolean(config.keys.tiingo),
      polygon: Boolean(config.keys.polygon),
    },
    universe: {
      subset: resolveUniverse().tickers.length,
      fullAvailable: hasFullUniverse(),
      fullCount: hasFullUniverse() ? resolveUniverse({ full: true }).tickers.length : 0,
    },
    note: 'SEC EDGAR fundamentals need no key. Provider keys unlock live prices and supplemental data. You may also enter keys in the UI for this session only.',
  });
});

/** Current scoring weights + recommended rebalancing (tuned or prior). */
router.get('/weights', (_req, res) => {
  const { weights, rebalancing, meta } = loadWeights();
  res.json({ weights, rebalancing, meta });
});

/**
 * Analyze one or more tickers.
 * body: { tickers: string|string[], riskLevel, keys? }
 */
router.post('/analyze', async (req, res) => {
  try {
    const riskLevel = riskOf(req.body);
    const rawTickers = Array.isArray(req.body?.tickers)
      ? req.body.tickers.join(' ')
      : req.body?.tickers || req.body?.ticker || '';
    const { valid, invalid } = parseTickerList(String(rawTickers), 25);

    if (!valid.length) {
      return res.status(400).json({
        error: 'No valid tickers provided.',
        invalid,
        hint: 'Enter 1-25 tickers like: AAPL, MSFT, KO',
      });
    }

    const keys = resolveKeys(req.body?.keys || {});
    const results = await mapLimit(valid, 4, (t) => analyzeTicker(t, riskLevel, keys));

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    const diversification = analyzeDiversification(
      ok.map((r) => ({
        ticker: r.ticker,
        sector: r.sector,
        industry: r.industry,
        cyclicalTheme: r.cyclicalTheme,
        score: r.score,
      })),
    );
    const peers = buildPeerComparison(ok);

    res.json({
      riskLevel,
      requested: valid,
      invalid,
      results,
      summary: {
        analyzed: ok.length,
        failed: failed.length,
        avgScore: ok.length
          ? Math.round(ok.reduce((s, r) => s + (r.score || 0), 0) / ok.length)
          : null,
      },
      diversification,
      peers,
      disclaimer:
        'Educational use only. Not financial advice. Figures may be estimated or incomplete — verify before acting.',
    });
  } catch (err) {
    logger.error('POST /analyze failed:', err);
    res.status(500).json({ error: 'Internal error analyzing tickers.', detail: err.message });
  }
});

/**
 * Screen a universe of tickers, returning ranked results for the risk level.
 * body: { tickers?: string[], riskLevel, keys? }
 * If no tickers supplied, falls back to a small built-in demo list.
 */
router.post('/screen', async (req, res) => {
  try {
    const riskLevel = riskOf(req.body);
    const rawTickers = Array.isArray(req.body?.tickers)
      ? req.body.tickers.join(' ')
      : req.body?.tickers || '';
    let { valid, invalid } = parseTickerList(String(rawTickers), 40);
    if (!valid.length) {
      valid = DEFAULT_SCREEN_UNIVERSE;
    }

    const keys = resolveKeys(req.body?.keys || {});
    const results = await mapLimit(valid, 4, (t) => analyzeTicker(t, riskLevel, keys));
    const ok = results.filter((r) => r.ok).sort((a, b) => (b.score || 0) - (a.score || 0));

    const diversification = analyzeDiversification(
      ok.slice(0, 15).map((r) => ({
        ticker: r.ticker,
        sector: r.sector,
        cyclicalTheme: r.cyclicalTheme,
        score: r.score,
      })),
    );

    res.json({
      riskLevel,
      universeSize: valid.length,
      invalid,
      ranked: ok.map((r) => ({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        score: r.score,
        rating: r.rating,
        marginOfSafety: r.valuation?.marginOfSafety ?? null,
        price: r.price,
      })),
      diversification,
      failed: results.filter((r) => !r.ok).map((r) => ({ ticker: r.ticker, error: r.error })),
      disclaimer: 'Educational use only. Not financial advice.',
    });
  } catch (err) {
    logger.error('POST /screen failed:', err);
    res.status(500).json({ error: 'Internal error screening universe.', detail: err.message });
  }
});

/**
 * Build a concentrated "best ideas" portfolio: evaluate a universe (default: a
 * representative Russell 1000 large-cap subset), then pick the top `size` names
 * by the risk-level score, capped at `perSector` per sector.
 * body: { riskLevel, size?, perSector?, universe?, keys? }
 *
 * NOTE: a cold run evaluates ~140 companies against SEC EDGAR and can take a
 * minute or two; results are cached so subsequent builds are fast.
 */
router.post('/portfolio', async (req, res) => {
  try {
    const riskLevel = riskOf(req.body);
    const size = Math.min(30, Math.max(1, parseInt(req.body?.size, 10) || 12));
    const perSector = Math.min(6, Math.max(1, parseInt(req.body?.perSector, 10) || 3));

    // Resolve the universe in priority order:
    //   1. a custom pasted list, else
    //   2. the FULL Russell 1000 (if `full` and data/universe/russell1000.json
    //      exists — populate it via `npm run fetch-universe`), else
    //   3. the built-in representative subset.
    let universe;
    let universeMeta;
    const raw = Array.isArray(req.body?.universe)
      ? req.body.universe.join(' ')
      : req.body?.universe || '';
    if (raw.trim()) {
      const parsed = parseTickerList(String(raw), 1100);
      universe = parsed.valid;
      universeMeta = { name: 'Custom universe', count: parsed.valid.length, note: 'User-supplied tickers.' };
    } else {
      const resolved = resolveUniverse({ full: req.body?.full === true });
      universe = resolved.tickers;
      universeMeta = resolved.meta;
    }
    if (!universe.length) {
      return res.status(400).json({ error: 'No valid tickers to evaluate.' });
    }

    const keys = resolveKeys(req.body?.keys || {});
    // Stay under SEC EDGAR's ~10 req/s fair-access limit (~2 SEC calls/company):
    // throttle hard for large universes to avoid 429 backoff storms.
    const concurrency = universe.length > 400 ? 4 : 6;
    const results = await mapLimit(universe, concurrency, (t) => analyzeTicker(t, riskLevel, keys));

    const pick = selectPortfolio(results, { riskLevel, size, perSector });
    const slim = (r, i) => ({
      rank: i + 1,
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      industry: r.industry,
      score: r.score,
      rating: r.rating,
      marginOfSafety: r.valuation?.marginOfSafety ?? null,
      marginCapped: r.valuation?.marginCapped ?? false,
      price: r.price,
      topStrength: r.strengths?.[0]?.label ?? null,
    });

    const diversification = analyzeDiversification(
      pick.selected.map((r) => ({
        ticker: r.ticker,
        sector: r.sector,
        cyclicalTheme: r.cyclicalTheme,
        score: r.score,
      })),
      { maxSectorShare: (perSector + 0.01) / size }, // cap-consistent threshold
    );

    const { rebalancing } = loadWeights();

    res.json({
      riskLevel,
      size,
      perSector,
      universe: universeMeta,
      evaluated: pick.evaluated,
      analyzed: pick.eligibleCount,
      failed: results.filter((r) => !r.ok).length,
      guardrailApplied: pick.guardrailApplied,
      portfolio: pick.selected.map(slim),
      sectorCount: pick.sectorCount,
      alternates: pick.benched.slice(0, 8).map((r) => ({
        ticker: r.ticker,
        sector: r.sector,
        score: r.score,
        rating: r.rating,
      })),
      avgScore: pick.selected.length
        ? Math.round(pick.selected.reduce((s, r) => s + r.score, 0) / pick.selected.length)
        : null,
      recommendedRebalance: rebalancing?.[riskLevel] || 'annual',
      diversification,
      disclaimer:
        'Educational use only. Not financial advice. A rules-based screen of a representative universe — not a recommendation to buy.',
    });
  } catch (err) {
    logger.error('POST /portfolio failed:', err);
    res.status(500).json({ error: 'Internal error building portfolio.', detail: err.message });
  }
});

/** Serve the backtesting dashboard report (generated by `npm run tune`). */
router.get('/backtest', (_req, res) => {
  const file = path.join(config.paths.backtestResults, 'report.json');
  if (!fs.existsSync(file)) {
    return res.status(404).json({
      error: 'No backtest report found. Run `npm run tune` to generate it.',
    });
  }
  try {
    res.type('application/json').send(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: 'Could not read backtest report.', detail: err.message });
  }
});

/** Validate a single ticker without a full analysis (lightweight UI helper). */
router.get('/validate/:ticker', (req, res) => {
  const norm = normalizeTicker(req.params.ticker);
  res.json({ ticker: req.params.ticker, valid: Boolean(norm), normalized: norm });
});

// A small, sector-diverse demo universe for the "screen market" button when the
// user doesn't supply their own list. Intentionally spans many sectors.
const DEFAULT_SCREEN_UNIVERSE = [
  'AAPL', 'MSFT', 'KO', 'PEP', 'JNJ', 'PG', 'WMT', 'COST', 'HD', 'MCD',
  'V', 'MA', 'JPM', 'UNH', 'XOM', 'CVX', 'CAT', 'HON', 'LMT', 'GOOGL',
];
