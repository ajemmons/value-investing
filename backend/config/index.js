/**
 * Central configuration loader.
 *
 * Reads from environment variables (via dotenv) with safe defaults. API keys
 * are NEVER hard-coded — they come from the environment or are supplied at
 * request time by the user through the UI and passed transiently.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // SEC EDGAR demands a descriptive User-Agent (their fair-access policy).
  secUserAgent:
    process.env.SEC_USER_AGENT ||
    'BuffettGrahamEvaluator/1.0 (contact: set-SEC_USER_AGENT@example.com)',

  // Optional provider keys. Empty string => provider disabled.
  keys: {
    fmp: process.env.FMP_API_KEY || '',
    alphaVantage: process.env.ALPHAVANTAGE_API_KEY || '',
    tiingo: process.env.TIINGO_API_KEY || '',
    polygon: process.env.POLYGON_API_KEY || '',
  },

  cache: {
    dir: path.join(ROOT, 'data', 'cached_api_data'),
    ttlHours: parseFloat(process.env.CACHE_TTL_HOURS || '168'),
    priceTtlHours: parseFloat(process.env.PRICE_CACHE_TTL_HOURS || '12'),
  },

  paths: {
    root: ROOT,
    frontend: path.join(ROOT, 'frontend'),
    data: path.join(ROOT, 'data'),
    historical: path.join(ROOT, 'data', 'historical'),
    backtestResults: path.join(ROOT, 'data', 'backtest_results'),
  },
};

/**
 * Merge request-supplied keys (entered in the UI) over the env defaults.
 * Request keys win so a user can override without restarting the server, but
 * they are used only for the lifetime of that request and never persisted.
 *
 * @param {Object} [requestKeys] partial map e.g. { fmp, alphaVantage }
 * @returns {Object} effective key map
 */
export function resolveKeys(requestKeys = {}) {
  return {
    fmp: requestKeys.fmp || config.keys.fmp,
    alphaVantage: requestKeys.alphaVantage || config.keys.alphaVantage,
    tiingo: requestKeys.tiingo || config.keys.tiingo,
    polygon: requestKeys.polygon || config.keys.polygon,
  };
}
