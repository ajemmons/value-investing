/**
 * SEC EDGAR data service — the primary, FREE, no-API-key fundamentals source.
 *
 * Two endpoints are used:
 *   1. company_tickers.json  -> map ticker symbol to CIK (zero-padded to 10).
 *   2. /api/xbrl/companyfacts/CIK##########.json -> all XBRL facts for a filer.
 *
 * We normalize the messy XBRL "facts" into a clean array of annual financial
 * statements (one entry per fiscal year), pulling each line item from a list of
 * fallback US-GAAP concept names because companies tag differently.
 *
 * Point-in-time integrity: each fact carries the filing date ("filed") and the
 * period end ("end"). The backtester can therefore reconstruct what was known on
 * any historical date — a key defense against hindsight bias.
 */
import { config } from '../config/index.js';
import { cached } from '../utils/cache.js';
import { getJson } from './httpClient.js';
import { logger } from '../utils/logger.js';
import { isNum } from '../utils/validation.js';

const SEC_HEADERS = () => ({
  'User-Agent': config.secUserAgent,
  'Accept-Encoding': 'gzip, deflate',
});

// Concept fallback lists. Order matters: first match wins per fiscal year.
const CONCEPTS = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingIncome: ['OperatingIncomeLoss'],
  pretaxIncome: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  depreciationAmortization: [
    'DepreciationDepletionAndAmortization',
    'DepreciationAmortizationAndAccretionNet',
    'DepreciationAndAmortization',
    'DepreciationDepletionAndAmortizationNonproduction',
  ],
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ],
  interestExpense: ['InterestExpense', 'InterestAndDebtExpense', 'InterestExpenseDebt'],
  // Balance sheet (instant)
  totalEquity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  totalAssets: ['Assets'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  longTermDebtCurrent: ['LongTermDebtCurrent', 'DebtCurrent'],
  shortTermDebt: ['ShortTermBorrowings', 'CommercialPaper'],
  sharesOutstanding: [
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
    'CommonStockSharesOutstanding',
  ],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
};

let tickerMapPromise = null;

/** Load and cache the ticker -> CIK map from SEC. */
async function getTickerMap() {
  if (!tickerMapPromise) {
    tickerMapPromise = cached('sec_ticker_map', 'all', 24 * 30, async () => {
      const data = await getJson('https://www.sec.gov/files/company_tickers.json', {
        headers: SEC_HEADERS(),
      });
      const map = {};
      for (const k of Object.keys(data)) {
        const row = data[k];
        if (row?.ticker) {
          map[row.ticker.toUpperCase()] = {
            cik: String(row.cik_str).padStart(10, '0'),
            title: row.title,
          };
        }
      }
      return map;
    }).catch((err) => {
      tickerMapPromise = null; // allow retry next time
      throw err;
    });
  }
  return tickerMapPromise;
}

/** Resolve a ticker to { cik, title } or null if not found in EDGAR.
 *  SEC uses hyphens for share classes (e.g. BRK-B); accept dot/hyphen variants. */
export async function resolveCik(ticker) {
  const map = await getTickerMap();
  const t = ticker.toUpperCase();
  return map[t] || map[t.replace('.', '-')] || map[t.replace('-', '.')] || null;
}

/** Fetch raw company facts JSON (cached). */
async function getCompanyFacts(cik) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  return cached(`sec_facts_${cik}`, url, config.cache.ttlHours, () =>
    getJson(url, { headers: SEC_HEADERS() }),
  );
}

/**
 * Extract annual values for a concept keyed by fiscal year.
 * @param {Object} facts companyfacts JSON
 * @param {string[]} conceptNames fallback list
 * @param {'duration'|'instant'} kind period type
 * @returns {Map<number,{value:number, filed:string, end:string}>}
 */
function extractAnnual(facts, conceptNames, kind) {
  const out = new Map();
  const gaap = facts?.facts?.['us-gaap'] || {};
  const dei = facts?.facts?.dei || {};
  for (const name of conceptNames) {
    const node = gaap[name] || dei[name];
    if (!node?.units) continue;
    // Prefer USD; for shares use 'shares'; for EPS use 'USD/shares'.
    const unitKey =
      Object.keys(node.units).find((u) => u === 'USD') ||
      Object.keys(node.units).find((u) => u === 'shares') ||
      Object.keys(node.units).find((u) => u.includes('/shares')) ||
      Object.keys(node.units)[0];
    const series = node.units[unitKey] || [];
    for (const item of series) {
      if (!isNum(item.val)) continue;
      // Annual figures only: form 10-K / 20-F and fiscal-period "FY".
      const isAnnualForm = /10-K|20-F|40-F/.test(item.form || '');
      if (item.fp && item.fp !== 'FY') continue;
      if (kind === 'duration') {
        if (!item.start || !item.end) continue;
        const days = (new Date(item.end) - new Date(item.start)) / 86400000;
        if (days < 300 || days > 400) continue; // ~ full year only
      } else {
        if (!item.end || item.start) continue; // instant has end only
      }
      if (!isAnnualForm && !item.frame) continue;
      const fy = new Date(item.end).getUTCFullYear();
      const prev = out.get(fy);
      // Keep the most recently FILED value for that fiscal year (latest restatement).
      if (!prev || new Date(item.filed) > new Date(prev.filed)) {
        out.set(fy, { value: item.val, filed: item.filed, end: item.end });
      }
    }
    // If we found data for this concept, don't fall through to weaker synonyms
    // for years we already have — but allow filling gaps from later synonyms.
  }
  return out;
}

function pick(map, fy, field = 'value') {
  const e = map.get(fy);
  return e ? e[field] : null;
}

/**
 * Build a normalized, chronologically sorted array of annual statements.
 * Each entry includes a `asOf` (latest filing date for that year) used for
 * point-in-time reconstruction in the backtester.
 *
 * @returns {Promise<{cik, name, annual: Array<Object>}>}
 */
export async function getNormalizedFinancials(ticker) {
  const info = await resolveCik(ticker);
  if (!info) {
    const e = new Error(`Ticker ${ticker} not found in SEC EDGAR (may be non-US or delisted).`);
    e.code = 'NOT_FOUND';
    throw e;
  }
  const facts = await getCompanyFacts(info.cik);

  const maps = {};
  for (const [field, names] of Object.entries(CONCEPTS)) {
    const kind = [
      'totalEquity',
      'cash',
      'totalAssets',
      'longTermDebt',
      'longTermDebtCurrent',
      'shortTermDebt',
      'sharesOutstanding',
    ].includes(field)
      ? 'instant'
      : 'duration';
    // sharesOutstanding may be reported either way; try instant first, then duration.
    maps[field] = extractAnnual(facts, names, kind);
    if (field === 'sharesOutstanding' && maps[field].size === 0) {
      maps[field] = extractAnnual(facts, names, 'duration');
    }
  }

  // Collect the union of fiscal years across the core statements.
  const years = new Set();
  for (const m of Object.values(maps)) for (const y of m.keys()) years.add(y);
  const sortedYears = [...years].sort((a, b) => a - b);

  const annual = sortedYears
    .map((fy) => {
      const ltd = pick(maps.longTermDebt, fy);
      const ltdCur = pick(maps.longTermDebtCurrent, fy);
      const std = pick(maps.shortTermDebt, fy);
      const totalDebt =
        [ltd, ltdCur, std].some(isNum)
          ? (isNum(ltd) ? ltd : 0) + (isNum(ltdCur) ? ltdCur : 0) + (isNum(std) ? std : 0)
          : null;

      const operatingIncome = pick(maps.operatingIncome, fy);
      const da = pick(maps.depreciationAmortization, fy);
      const ebitda = isNum(operatingIncome) && isNum(da) ? operatingIncome + da : null;

      const pretax = pick(maps.pretaxIncome, fy);
      const tax = pick(maps.incomeTax, fy);
      const taxRate = isNum(pretax) && isNum(tax) && Math.abs(pretax) > 1e-6 ? tax / pretax : null;

      // The "asOf" date is the latest filing among this year's facts — the
      // earliest date this full-year picture was publicly available.
      const filedDates = Object.values(maps)
        .map((m) => m.get(fy)?.filed)
        .filter(Boolean)
        .sort();
      const asOf = filedDates.length ? filedDates[filedDates.length - 1] : `${fy}-12-31`;

      return {
        fiscalYear: fy,
        asOf,
        revenue: pick(maps.revenue, fy),
        netIncome: pick(maps.netIncome, fy),
        operatingIncome,
        pretaxIncome: pretax,
        incomeTax: tax,
        taxRate,
        depreciationAmortization: da,
        ebitda,
        operatingCashFlow: pick(maps.operatingCashFlow, fy),
        capex: pick(maps.capex, fy),
        interestExpense: pick(maps.interestExpense, fy),
        totalEquity: pick(maps.totalEquity, fy),
        cash: pick(maps.cash, fy),
        totalAssets: pick(maps.totalAssets, fy),
        totalDebt,
        sharesOutstanding: pick(maps.sharesOutstanding, fy),
        epsDiluted: pick(maps.epsDiluted, fy),
      };
    })
    // Require at least revenue or net income to consider a year usable.
    .filter((y) => isNum(y.revenue) || isNum(y.netIncome));

  if (!annual.length) {
    const e = new Error(`No usable XBRL financial data for ${ticker} in EDGAR.`);
    e.code = 'NO_DATA';
    throw e;
  }

  logger.debug(`SEC: ${ticker} -> ${annual.length} annual periods (${info.cik})`);
  return { cik: info.cik, name: info.title, ticker: ticker.toUpperCase(), annual };
}
