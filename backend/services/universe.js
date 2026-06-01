/**
 * Representative large-cap subset of the Russell 1000.
 *
 * ⚠️ HONESTY: This is NOT the full 1,000-name Russell 1000. Evaluating all 1,000
 * constituents LIVE against free SEC EDGAR data in a single web request is not
 * practical (1,000 large `companyfacts` downloads → many minutes + rate limits),
 * and no free API provides point-in-time index membership. So we ship a curated,
 * liquid, sector-diverse core of real Russell 1000 members (~195 names) that the
 * portfolio builder can evaluate in a reasonable time, with disk caching so
 * repeat builds are fast. Users can paste a larger custom universe to override.
 *
 * The list spans every GICS-style sector so the "max 3 per sector" rule has real
 * choices in each bucket. To evaluate the FULL 1,000, drop a constituent list at
 * data/universe/russell1000.json (see `npm run fetch-universe`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

export const RUSSELL_1000_SUBSET = dedupe([
  // Technology
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'CSCO',
  'ACN', 'TXN', 'QCOM', 'IBM', 'NOW', 'INTU', 'AMAT', 'MU', 'LRCX', 'ADI',
  'KLAC', 'SNPS', 'CDNS', 'PANW', 'FTNT', 'CRWD', 'DELL', 'HPQ', 'NXPI', 'MCHP',
  // Communication Services
  'GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'EA', 'TTWO', 'OMC',
  // Consumer Discretionary
  'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
  'ORLY', 'AZO', 'ROST', 'MAR', 'HLT', 'GM', 'F', 'YUM', 'DHI', 'LEN',
  // Consumer Staples
  'PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'KMB',
  'GIS', 'KHC', 'STZ', 'KDP', 'HSY', 'SYY', 'KR', 'ADM', 'MNST', 'CHD',
  // Healthcare
  'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'BMY',
  'AMGN', 'MDT', 'ISRG', 'CVS', 'GILD', 'VRTX', 'REGN', 'ZTS', 'BSX', 'CI',
  'ELV', 'MCK', 'BDX', 'SYK', 'HCA',
  // Financials
  'BRK-B', 'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SPGI', 'AXP',
  'SCHW', 'CB', 'PGR', 'USB', 'PNC', 'COF', 'MMC', 'AON', 'ICE', 'CME', 'MCO', 'TRV',
  // Industrials
  'CAT', 'HON', 'UNP', 'GE', 'BA', 'RTX', 'LMT', 'DE', 'UPS', 'ADP',
  'GD', 'NOC', 'MMM', 'ITW', 'EMR', 'ETN', 'CSX', 'NSC', 'FDX', 'WM', 'PH', 'CMI',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'WMB', 'KMI', 'HAL',
  // Materials
  'LIN', 'APD', 'SHW', 'ECL', 'FCX', 'NEM', 'DOW', 'NUE', 'PPG', 'VMC', 'MLM',
  // Utilities
  'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'ED', 'PEG', 'WEC',
  // Real Estate
  'PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'O', 'SPG', 'WELL', 'DLR', 'AVB',
]);

export const UNIVERSE_META = {
  name: 'Russell 1000 (representative large-cap subset)',
  count: RUSSELL_1000_SUBSET.length,
  note:
    'A liquid, sector-diverse subset of real Russell 1000 members. Not the full 1,000 constituents — evaluating those live against free SEC data is impractical. Paste a custom list to override.',
};

// Optional FULL constituent list. Drop a JSON array of tickers here (e.g. via
// `npm run fetch-universe`) to evaluate the entire Russell 1000.
export const FULL_UNIVERSE_PATH = path.join(config.paths.data, 'universe', 'russell1000.json');

/** Load the full constituent list from disk, or null if not present. */
export function loadFullUniverse() {
  try {
    if (fs.existsSync(FULL_UNIVERSE_PATH)) {
      const arr = JSON.parse(fs.readFileSync(FULL_UNIVERSE_PATH, 'utf8'));
      if (Array.isArray(arr) && arr.length) return dedupe(arr);
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export function hasFullUniverse() {
  return loadFullUniverse() !== null;
}

/**
 * Resolve which universe to evaluate.
 * @param {Object} [opts]
 * @param {boolean} [opts.full] use the full constituent file if available
 * @returns {{tickers:string[], meta:Object}}
 */
export function resolveUniverse({ full = false } = {}) {
  if (full) {
    const list = loadFullUniverse();
    if (list) {
      return {
        tickers: list,
        meta: {
          name: `Full universe (${list.length} names · S&P 1500 / Russell 1000 proxy)`,
          count: list.length,
          note: `Loaded ${list.length} tickers from data/universe/russell1000.json (S&P Composite 1500 — a superset proxy for the Russell 1000).`,
        },
      };
    }
  }
  return { tickers: RUSSELL_1000_SUBSET, meta: UNIVERSE_META };
}

function dedupe(arr) {
  return [...new Set(arr.map((t) => String(t).toUpperCase()))];
}
