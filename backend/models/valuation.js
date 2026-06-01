/**
 * Intrinsic value via a two-stage discounted cash flow (DCF) on owner earnings
 * (falling back to free cash flow). Produces base / conservative / aggressive
 * cases, a margin of safety vs. market price, and a CONTEXTUAL P/E read.
 *
 * Design principles:
 *  - Transparent assumptions (discount rate, growth, terminal growth) returned
 *    with the result so the UI can show exactly how the number was built.
 *  - P/E is never a standalone reward/penalty. It is interpreted relative to
 *    sector norms, the company's own growth, ROIC, FCF quality, and balance
 *    sheet — producing only a small adjustment to the valuation sub-score.
 */
import { isNum, clamp } from '../utils/validation.js';
import { safeDiv } from '../utils/financialMath.js';

// Rough long-run sector P/E baselines (illustrative; used only when peer data
// is unavailable). Documented as estimates in the UI.
const SECTOR_PE_BASELINE = {
  Technology: 26,
  Healthcare: 20,
  Financials: 13,
  'Consumer Staples': 21,
  'Consumer Discretionary': 20,
  Industrials: 19,
  Energy: 12,
  'Energy & Materials': 12,
  Materials: 15,
  Utilities: 18,
  'Real Estate': 22,
  'Communication Services': 19,
  Agriculture: 14,
  Construction: 14,
  Other: 18,
  Unknown: 18,
};

/**
 * Run a two-stage DCF.
 * @param {Object} args
 * @param {number} args.baseCashFlow starting owner earnings (or FCF)
 * @param {number} args.growthRate stage-1 annual growth (decimal)
 * @param {number} args.discountRate required return (decimal)
 * @param {number} args.terminalGrowth perpetual growth after stage 1 (decimal)
 * @param {number} [args.years=10] stage-1 length
 * @param {number} [args.netCash] add net cash (cash - debt) to equity value
 * @param {number} [args.shares] divide by shares for per-share value
 * @returns {{equityValue:number|null, perShare:number|null}}
 */
function dcf({ baseCashFlow, growthRate, discountRate, terminalGrowth, years = 10, netCash = 0, shares }) {
  if (!isNum(baseCashFlow) || baseCashFlow <= 0) return { equityValue: null, perShare: null };
  if (!isNum(discountRate) || discountRate <= terminalGrowth) return { equityValue: null, perShare: null };

  let pv = 0;
  let cf = baseCashFlow;
  for (let t = 1; t <= years; t++) {
    cf *= 1 + growthRate;
    pv += cf / (1 + discountRate) ** t;
  }
  // Gordon terminal value on year-N cash flow.
  const terminalCf = cf * (1 + terminalGrowth);
  const terminalValue = terminalCf / (discountRate - terminalGrowth);
  pv += terminalValue / (1 + discountRate) ** years;

  const equityValue = pv + (isNum(netCash) ? netCash : 0);
  const perShare = isNum(shares) && shares > 0 ? equityValue / shares : null;
  return { equityValue, perShare };
}

/**
 * Build a full valuation across three scenarios.
 * @param {Object} model financialModel output
 * @param {Object} ctx { price, sharesOutstanding, sector, netCash, riskLevel }
 */
export function valueCompany(model, ctx = {}) {
  const m = model.metrics;
  const shares = isNum(ctx.sharesOutstanding) ? ctx.sharesOutstanding : m.sharesLatest;

  // Choose the starting cash flow for the DCF. Prefer TRAILING-TWELVE-MONTH
  // figures (this valuation step is the only place TTM is used, so the price is
  // matched against current-ish earnings); fall back to the latest annual.
  const ttm = ctx.ttm;
  let base = null;
  let baseSource = 'net income';
  let basis = `FY${m.latestFiscalYear ?? ''}`;
  if (ttm) {
    const cands = [
      [ttm.ownerEarnings, 'owner earnings'],
      [ttm.fcf, 'free cash flow'],
      [ttm.netIncome, 'net income'],
    ];
    const hit = cands.find(([v]) => isNum(v) && v > 0);
    if (hit) {
      [base, baseSource] = hit;
      basis = ttm.fresh ? `trailing 12 months${ttm.end ? ` (through ${ttm.end})` : ''}` : `FY${m.latestFiscalYear ?? ''}`;
    }
  }
  if (!isNum(base)) {
    base = [m.ownerEarningsLatest, m.fcfLatest, m.netIncomeLatest].find((x) => isNum(x) && x > 0) ?? null;
    baseSource =
      base === m.ownerEarningsLatest ? 'owner earnings' : base === m.fcfLatest ? 'free cash flow' : 'net income';
    basis = `FY${m.latestFiscalYear ?? ''}`;
  }

  // TTM earnings per share for the contextual P/E (falls back to annual EPS).
  const ttmEps = ttm && isNum(ttm.netIncome) && isNum(shares) && shares > 0 ? ttm.netIncome / shares : null;

  // Historical growth signal, dampened toward prudence and clamped.
  const histGrowth = [m.ownerEarningsCagr, m.fcfCagr, m.revenueCagr].find((x) => isNum(x));
  const g = clamp(isNum(histGrowth) ? histGrowth : 0.04, -0.02, 0.18, 0.04);

  // Risk-adjusted discount rate: conservative demands a higher return.
  const discountByRisk = { conservative: 0.11, moderate: 0.1, aggressive: 0.09 };
  const discountRate = discountByRisk[ctx.riskLevel] || 0.1;
  const terminalGrowth = 0.025;

  const netCash = isNum(ctx.netCash) ? ctx.netCash : 0;

  const scenarios = {
    conservative: dcf({
      baseCashFlow: base,
      growthRate: clamp(g * 0.5, -0.02, 0.08, 0.02),
      discountRate: discountRate + 0.01,
      terminalGrowth: 0.02,
      netCash,
      shares,
    }),
    base: dcf({
      baseCashFlow: base,
      growthRate: clamp(g * 0.8, 0, 0.12, 0.04),
      discountRate,
      terminalGrowth,
      netCash,
      shares,
    }),
    aggressive: dcf({
      baseCashFlow: base,
      growthRate: clamp(g, 0, 0.18, 0.06),
      discountRate: discountRate - 0.005,
      terminalGrowth: 0.03,
      netCash,
      shares,
    }),
  };

  const price = isNum(ctx.price) ? ctx.price : null;
  const basePerShare = scenarios.base.perShare;
  const rawMargin =
    isNum(price) && isNum(basePerShare) && price > 0 ? basePerShare / price - 1 : null;
  // Cap the reported margin of safety: a two-stage DCF can balloon for high-
  // cash-flow, low-price names, and beyond ~+200% the precision is meaningless
  // (the scoring curve already saturates at +60%). We clamp for display honesty
  // and flag when the raw figure was extreme so users verify the assumptions.
  const MOS_CAP = 2.0;
  const marginOfSafety = isNum(rawMargin) ? clamp(rawMargin, -0.95, MOS_CAP, rawMargin) : null;
  const marginCapped = isNum(rawMargin) && rawMargin > MOS_CAP;

  const peContext = evaluatePeContext({ model, price, sector: ctx.sector, peerPe: ctx.peerPe, eps: ttmEps });

  return {
    available: isNum(basePerShare),
    baseSource,
    basis, // "trailing 12 months (through …)" or "FY####"
    assumptions: {
      startingCashFlow: base,
      stage1GrowthBase: clamp(g * 0.8, 0, 0.12, 0.04),
      discountRate,
      terminalGrowth,
      years: 10,
      note: `Two-stage DCF on ${baseSource} (${basis}); growth dampened from historical and clamped for prudence.`,
    },
    scenarios: {
      conservative: scenarios.conservative.perShare,
      base: basePerShare,
      aggressive: scenarios.aggressive.perShare,
    },
    price,
    marginOfSafety,
    marginCapped,
    peContext,
  };
}

/**
 * Contextual P/E evaluation. Returns a small score adjustment plus a human
 * summary. A low P/E only earns credit when business quality supports it; a high
 * P/E is only penalized when growth/quality do NOT justify it.
 *
 * @returns {{pe:number|null, sectorPe:number, adjustment:number, summary:string}}
 */
export function evaluatePeContext({ model, price, sector, peerPe, eps: epsOverride }) {
  const m = model.metrics;
  // Prefer a TTM EPS (matches the live price); fall back to latest annual EPS.
  const eps = isNum(epsOverride) && epsOverride > 0 ? epsOverride : m.epsLatest;
  const pe = isNum(price) && isNum(eps) && eps > 0 ? price / eps : null;
  const sectorPe = isNum(peerPe) ? peerPe : SECTOR_PE_BASELINE[sector] || SECTOR_PE_BASELINE.Unknown;

  if (!isNum(pe)) {
    return { pe: null, sectorPe, adjustment: 0, summary: 'P/E n/a (no positive EPS or price)' };
  }

  const relative = pe / sectorPe - 1; // >0 = premium to sector
  // Quality support: ROIC, FCF positivity, low debt, earnings growth.
  const qualitySignals = [
    isNum(m.roicLatest) && m.roicLatest > 0.12,
    isNum(m.fcfPositiveRatio) && m.fcfPositiveRatio > 0.7,
    isNum(m.debtToEquityLatest) && m.debtToEquityLatest < 1,
    isNum(m.ownerEarningsCagr) && m.ownerEarningsCagr > 0.08,
  ].filter(Boolean).length;
  const growth = isNum(m.ownerEarningsCagr) ? m.ownerEarningsCagr : m.revenueCagr;
  const peg = isNum(growth) && growth > 0 ? pe / (growth * 100) : null;

  let adjustment = 0;
  let verdict;
  if (relative < -0.15) {
    // Cheaper than sector: reward only if quality is decent (else value trap).
    if (qualitySignals >= 3) {
      adjustment = 6;
      verdict = 'discount to sector backed by strong quality (potential value)';
    } else if (qualitySignals <= 1) {
      adjustment = -4;
      verdict = 'cheap vs sector but weak quality (possible value trap)';
    } else {
      adjustment = 1;
      verdict = 'modest discount to sector, mixed quality';
    }
  } else if (relative > 0.25) {
    // Premium to sector: justified only by growth + quality.
    if (qualitySignals >= 3 && isNum(peg) && peg < 2) {
      adjustment = 2;
      verdict = 'premium to sector justified by growth and quality';
    } else {
      adjustment = -6;
      verdict = 'premium to sector not supported by growth/quality';
    }
  } else {
    adjustment = 0;
    verdict = 'roughly in line with sector';
  }

  const summary = `P/E ${pe.toFixed(1)} vs sector ~${sectorPe} — ${verdict}${
    isNum(peg) ? ` (PEG ${peg.toFixed(1)})` : ''
  }`;
  return { pe, sectorPe, peg, adjustment, summary };
}
