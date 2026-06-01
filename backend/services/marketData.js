/**
 * Market data service: current price, market cap, and sector/industry.
 *
 * Strategy (graceful degradation):
 *   - Sector/industry: SEC submissions endpoint (free, no key) -> SIC mapping.
 *   - Price/market cap: Financial Modeling Prep if a key is supplied, else a
 *     no-key Yahoo-compatible chart endpoint as a best-effort fallback.
 *
 * Any failure returns nulls with a `sources`/`notes` trail rather than throwing,
 * so the scorecard can still render fundamentals-only analysis.
 */
import { config } from '../config/index.js';
import { cached } from '../utils/cache.js';
import { getJson } from './httpClient.js';
import { classifySic } from './sicMapping.js';
import { logger } from '../utils/logger.js';
import { isNum } from '../utils/validation.js';

const SEC_HEADERS = () => ({ 'User-Agent': config.secUserAgent });

/** Sector & industry from SEC submissions metadata (cached ~30 days). */
export async function getSectorIndustry(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  try {
    const data = await cached(`sec_submissions_${cik}`, url, 24 * 30, () =>
      getJson(url, { headers: SEC_HEADERS() }),
    );
    return classifySic(data.sic, data.sicDescription);
  } catch (err) {
    logger.warn(`sector lookup failed for CIK ${cik}: ${err.message}`);
    return { sector: 'Unknown', industry: 'Unknown', cyclicalTheme: null };
  }
}

/** FMP quote (requires key). Returns { price, marketCap, peRatio } or null. */
async function fmpQuote(ticker, key) {
  if (!key) return null;
  const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(
    ticker,
  )}?apikey=${key}`;
  try {
    const arr = await cached(`fmp_quote_${ticker}`, url, config.cache.priceTtlHours, () =>
      getJson(url),
    );
    const q = Array.isArray(arr) ? arr[0] : null;
    if (!q) return null;
    return {
      price: isNum(q.price) ? q.price : null,
      marketCap: isNum(q.marketCap) ? q.marketCap : null,
      peRatio: isNum(q.pe) ? q.pe : null,
      sharesOutstanding: isNum(q.sharesOutstanding) ? q.sharesOutstanding : null,
      source: 'fmp',
    };
  } catch (err) {
    logger.warn(`FMP quote failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/** No-key Yahoo-compatible chart endpoint for last price. Best-effort. */
async function yahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?interval=1d&range=1d`;
  try {
    const data = await cached(`yahoo_quote_${ticker}`, url, config.cache.priceTtlHours, () =>
      getJson(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price: isNum(meta.regularMarketPrice) ? meta.regularMarketPrice : null,
      marketCap: null,
      peRatio: null,
      sharesOutstanding: null,
      source: 'yahoo',
    };
  } catch (err) {
    logger.warn(`Yahoo quote failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a quote using whichever providers are available.
 * @param {string} ticker
 * @param {Object} keys effective key map from resolveKeys()
 */
export async function getQuote(ticker, keys = {}) {
  const fmp = await fmpQuote(ticker, keys.fmp);
  if (fmp?.price) return fmp;
  const yh = await yahooQuote(ticker);
  if (yh?.price) return yh;
  return { price: null, marketCap: null, peRatio: null, sharesOutstanding: null, source: 'none' };
}
