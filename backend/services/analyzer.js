/**
 * Orchestrates a full single-company evaluation:
 *   SEC fundamentals -> derived financial model -> sector/quote -> DCF valuation
 *   -> risk-adjusted score + scorecard.
 *
 * Designed to never throw for "expected" data problems — those are returned as a
 * structured { ok:false, error } so the API and UI can present them cleanly.
 */
import { getNormalizedFinancials } from './secEdgar.js';
import { getQuote, getSectorIndustry } from './marketData.js';
import { buildFinancialModel } from '../models/financialModel.js';
import { valueCompany } from '../models/valuation.js';
import { scoreCompany } from '../models/scoring.js';
import { loadWeights } from '../models/weights.js';
import { isNum } from '../utils/validation.js';
import { logger } from '../utils/logger.js';

// In-memory result cache: large universe builds (e.g. the full Russell 1000)
// re-evaluate the same tickers repeatedly. Caching the finished analysis (keyed
// by ticker+risk) makes the second build in a session near-instant. The
// underlying SEC/price data already has its own disk cache; this just avoids
// recomputing the model/score. Short TTL so fresh prices flow through.
const resultCache = new Map();
const RESULT_TTL_MS = 6 * 3600 * 1000;

/**
 * @param {string} ticker normalized ticker
 * @param {'conservative'|'moderate'|'aggressive'} riskLevel
 * @param {Object} keys effective provider keys
 * @returns {Promise<Object>} evaluation result
 */
export async function analyzeTicker(ticker, riskLevel = 'moderate', keys = {}) {
  const cacheKey = `${ticker}:${riskLevel}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.t < RESULT_TTL_MS) return cached.v;
  try {
    const fin = await getNormalizedFinancials(ticker); // throws NOT_FOUND/NO_DATA
    const model = buildFinancialModel(fin.annual);

    // Sector + quote in parallel; both are best-effort.
    const [sectorInfo, quote] = await Promise.all([
      getSectorIndustry(fin.cik),
      getQuote(ticker, keys),
    ]);

    const m = model.metrics;
    const shares = isNum(quote.sharesOutstanding) ? quote.sharesOutstanding : m.sharesLatest;
    const netCash =
      isNum(model.latest.cash) || isNum(model.latest.totalDebt)
        ? (model.latest.cash || 0) - (model.latest.totalDebt || 0)
        : 0;
    const marketCap = isNum(quote.marketCap)
      ? quote.marketCap
      : isNum(quote.price) && isNum(shares)
        ? quote.price * shares
        : null;

    const { weights } = loadWeights();
    const riskWeights = weights[riskLevel] || weights.moderate;

    const valuation = valueCompany(model, {
      price: quote.price,
      sharesOutstanding: shares,
      sector: sectorInfo.sector,
      netCash,
      riskLevel,
    });

    const scored = scoreCompany(model, valuation, riskWeights);

    const result = {
      ok: true,
      ticker: fin.ticker,
      name: fin.name,
      cik: fin.cik,
      riskLevel,
      sector: sectorInfo.sector,
      industry: sectorInfo.industry,
      cyclicalTheme: sectorInfo.cyclicalTheme,
      price: quote.price,
      priceSource: quote.source,
      marketCap,
      score: scored.score,
      rating: scored.rating,
      breakdown: scored.breakdown,
      strengths: scored.strengths,
      weaknesses: scored.weaknesses,
      coverage: scored.coverage,
      dataQuality: scored.dataQuality,
      valuation,
      metrics: summarizeMetrics(m, valuation),
      series: model.series,
      latestFiscalYear: m.latestFiscalYear,
      asOf: model.latest.asOf,
    };
    resultCache.set(cacheKey, { t: Date.now(), v: result });
    return result;
  } catch (err) {
    logger.warn(`analyzeTicker(${ticker}) failed: ${err.message}`);
    return {
      ok: false,
      ticker,
      riskLevel,
      error: {
        code: err.code || 'ERROR',
        message: err.message,
      },
    };
  }
}

/** Compact metric snapshot for the scorecard, including margin of safety. */
function summarizeMetrics(m, valuation) {
  return {
    roic: m.roicLatest,
    roicAvg: m.roicAvg,
    fcfCagr: m.fcfCagr,
    ownerEarningsCagr: m.ownerEarningsCagr,
    operatingMarginAvg: m.operatingMarginAvg,
    operatingMarginCoeffVar: m.operatingMarginCoeffVar,
    debtToEquity: m.debtToEquityLatest,
    netDebtToEbitda: m.netDebtToEbitdaLatest,
    interestCoverage: m.interestCoverageLatest,
    earningsPositiveRatio: m.earningsPositiveRatio,
    revenueCagr: m.revenueCagr,
    shareCountTrend: m.shareCountTrend,
    roe: m.roeLatest,
    pe: valuation?.peContext?.pe ?? null,
    sectorPe: valuation?.peContext?.sectorPe ?? null,
    marginOfSafety: valuation?.marginOfSafety ?? null,
    intrinsicValueBase: valuation?.scenarios?.base ?? null,
  };
}
