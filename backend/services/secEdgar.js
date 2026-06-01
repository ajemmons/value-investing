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

// ---------------------------------------------------------------------------
// Trailing-twelve-month (TTM) extraction — used ONLY by the valuation/P-E step.
// The ten quality metrics stay on audited annual data; valuation pairs a live
// price with the freshest available earnings, so it benefits from TTM.
// ---------------------------------------------------------------------------

const shiftYear = (dateStr, years) => {
  const d = new Date(dateStr);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

/** All duration (flow) observations for the first concept that has data. */
function durationObs(facts, conceptNames) {
  const gaap = facts?.facts?.['us-gaap'] || {};
  for (const name of conceptNames) {
    const node = gaap[name];
    if (!node?.units) continue;
    const unitKey = Object.keys(node.units).find((u) => u === 'USD') || Object.keys(node.units)[0];
    const obs = [];
    for (const it of node.units[unitKey] || []) {
      if (!isNum(it.val) || !it.start || !it.end) continue;
      obs.push({ val: it.val, start: it.start, end: it.end, filed: it.filed, days: dayDiff(it.end, it.start) });
    }
    if (obs.length) return obs;
  }
  return [];
}

/**
 * TTM value of a flow concept via the "stub" method:
 *   TTM = latest full fiscal year + current-year YTD − prior-year same YTD
 * Using cumulative YTD periods (rather than differencing quarters) is what makes
 * this robust to SEC's year-to-date cash-flow reporting. Falls back to the latest
 * full fiscal year when no newer interim filing exists.
 * @returns {{value:number|null, end:string|null, fresh:boolean}}
 */
function ttmFlow(facts, conceptNames) {
  const obs = durationObs(facts, conceptNames);
  if (!obs.length) return { value: null, end: null, fresh: false };

  // Dedupe identical periods, keeping the most recently filed (latest restatement).
  const byKey = new Map();
  for (const o of obs) {
    const k = `${o.start}|${o.end}`;
    const prev = byKey.get(k);
    if (!prev || new Date(o.filed) > new Date(prev.filed)) byKey.set(k, o);
  }
  const all = [...byKey.values()];
  const isAnnual = (o) => o.days >= 350 && o.days <= 380;
  const annuals = all.filter(isAnnual).sort((a, b) => new Date(b.end) - new Date(a.end));
  if (!annuals.length) return { value: null, end: null, fresh: false };
  const fy = annuals[0]; // latest complete fiscal year

  // Current-year YTD: a cumulative interim period beginning ~ at the start of the
  // new fiscal year (i.e. right after fy.end) and ending after fy.end.
  const ytds = all
    .filter((o) => new Date(o.end) > new Date(fy.end) && o.days >= 80 && o.days <= 370 && dayDiff(o.start, fy.end) <= 20)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
  if (!ytds.length) return { value: fy.val, end: fy.end, fresh: false };
  const cy = ytds[0];

  // Prior-year comparable YTD: same length, ending ~1 year before cy.end.
  const targetEnd = shiftYear(cy.end, -1);
  const py = all
    .filter((o) => Math.abs(o.days - cy.days) <= 25 && dayDiff(o.end, targetEnd) <= 25)
    .sort((a, b) => dayDiff(a.end, targetEnd) - dayDiff(b.end, targetEnd))[0];
  if (!py) return { value: fy.val, end: fy.end, fresh: false };

  return { value: fy.val + cy.val - py.val, end: cy.end, fresh: true };
}

/**
 * Compute TTM owner earnings / FCF / net income from raw facts, or null if the
 * income statement isn't available. `fresh` indicates the figure incorporates
 * interim data newer than the latest 10-K (otherwise it equals the latest FY).
 */
function computeTtm(facts) {
  const ni = ttmFlow(facts, CONCEPTS.netIncome);
  if (!isNum(ni.value)) return null;
  const ocf = ttmFlow(facts, CONCEPTS.operatingCashFlow);
  const capex = ttmFlow(facts, CONCEPTS.capex);
  const dep = ttmFlow(facts, CONCEPTS.depreciationAmortization);

  const da = isNum(dep.value) ? dep.value : 0;
  const capexMag = isNum(capex.value) ? Math.abs(capex.value) : null;
  const maintCapex = capexMag === null ? da : Math.min(capexMag, da);
  const ownerEarnings = ni.value + da - maintCapex;
  const fcf = isNum(ocf.value) ? ocf.value - (capexMag || 0) : null;

  return {
    netIncome: ni.value,
    ownerEarnings,
    fcf,
    end: ni.end,
    fresh: ni.fresh, // NI drives owner earnings; that's the freshness that matters
  };
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

  // TTM earnings for the valuation/P-E step (best-effort; null if unavailable).
  const ttm = computeTtm(facts);

  logger.debug(`SEC: ${ticker} -> ${annual.length} annual periods (${info.cik})`);
  return { cik: info.cik, name: info.title, ticker: ticker.toUpperCase(), annual, ttm };
}
