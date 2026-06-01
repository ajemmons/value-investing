/**
 * Synthetic — but bias-aware AND regime-aware — historical universe generator.
 *
 * ⚠️ IMPORTANT / HONESTY: This is ILLUSTRATIVE data, not real market history. A
 * genuinely survivorship-bias-free backtest needs point-in-time index
 * constituents PLUS full financials for delisted/bankrupt/merged firms, which no
 * free API fully provides. So we generate a deterministic universe that
 * *deliberately* includes losers (bankruptcies, declines, mergers, mediocre
 * compounders) alongside winners.
 *
 * Unlike a naive generator, this one models the messy dynamics that make the
 * real market HARD — so the backtest is a genuine stress test, not a layup:
 *
 *   1. FACTOR REGIME SHIFTS  — quality and value premia turn negative for stretches
 *      (junk rallies in 2009/2020-21, the value drought of 2017-2021, value's 2022
 *      comeback), so a fundamentals strategy does NOT win every window.
 *   2. MULTIPLE EXPANSION/COMPRESSION — prices are EPS × an evolving P/E multiple
 *      that mean-reverts toward a fundamentals-justified level but is pushed around
 *      by sentiment; returns come from re-rating, not just earnings.
 *   3. FAT-TAILED MEGA-WINNERS — a few names compound at extreme rates with
 *      persistent multiple expansion (the Nvidia/Amazon power law).
 *   4. SUDDEN BLOWUPS — rare, fundamentals-independent shocks (fraud/liquidity)
 *      that even a "clean" balance sheet cannot predict.
 *   5. SECTOR ROTATION & MACRO — a shared macro path (earnings cycle, rate changes)
 *      hits sectors differently (energy/financials like higher rates; high-multiple
 *      tech gets compressed), with explicit booms/busts per sector.
 *
 * The benchmark indices are DERIVED from the realized returns of this universe, so
 * the "market" and the stocks are internally consistent. See docs/limitations.md.
 *
 * The schema of each company's `annual[]` entry matches the SEC EDGAR normalizer
 * output, so the live scoring pipeline runs on it without modification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const START_YEAR = 2004;
const END_YEAR = 2023;
const N_YEARS = END_YEAR - START_YEAR + 1;
const SAMPLE_PATH = path.join(config.paths.historical, 'sample_universe.json');

/** Deterministic mulberry32 PRNG so the universe is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const idxOf = (year) => year - START_YEAR;

// Sectors with the attributes that drive their macro behavior.
//   cyclicality   — how much the macro earnings cycle swings the business
//   growthiness   — structural growth character (raises the "fair" multiple)
//   marginBase    — baseline operating margin
//   rateSens      — sensitivity of the P/E multiple to rising rates
//                   (positive = hurt by hikes; negative = helped, e.g. banks/energy)
const SECTORS = [
  { sector: 'Technology', theme: 'technology', cyclicality: 0.5, growthiness: 0.85, marginBase: 0.22, rateSens: 1.0 },
  { sector: 'Healthcare', theme: null, cyclicality: 0.2, growthiness: 0.5, marginBase: 0.18, rateSens: 0.35 },
  { sector: 'Financials', theme: 'financials', cyclicality: 0.8, growthiness: 0.3, marginBase: 0.28, rateSens: -0.6 },
  { sector: 'Consumer Staples', theme: null, cyclicality: 0.15, growthiness: 0.3, marginBase: 0.14, rateSens: 0.3 },
  { sector: 'Consumer Discretionary', theme: null, cyclicality: 0.8, growthiness: 0.55, marginBase: 0.1, rateSens: 0.6 },
  { sector: 'Industrials', theme: 'aerospace', cyclicality: 0.7, growthiness: 0.4, marginBase: 0.12, rateSens: 0.5 },
  { sector: 'Energy & Materials', theme: 'energy', cyclicality: 0.95, growthiness: 0.3, marginBase: 0.13, rateSens: -0.4 },
  { sector: 'Utilities', theme: null, cyclicality: 0.2, growthiness: 0.2, marginBase: 0.16, rateSens: 0.8 },
  { sector: 'Communication Services', theme: null, cyclicality: 0.55, growthiness: 0.6, marginBase: 0.17, rateSens: 0.7 },
];

// Outcome archetypes: quality range, growth tilt, and delisting behavior.
const ARCHETYPES = {
  winner: { weight: 0.12, q: [0.78, 0.95], growthTilt: 0.06 },
  solid: { weight: 0.28, q: [0.6, 0.78], growthTilt: 0.02 },
  mediocre: { weight: 0.32, q: [0.4, 0.6], growthTilt: 0.0 },
  decline: { weight: 0.14, q: [0.2, 0.42], growthTilt: -0.05 },
  bankrupt: { weight: 0.06, q: [0.05, 0.25], growthTilt: -0.1 },
  merged: { weight: 0.08, q: [0.45, 0.7], growthTilt: 0.01 },
};

function pickArchetype(r) {
  const x = r();
  let acc = 0;
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    acc += a.weight;
    if (x <= acc) return name;
  }
  return 'mediocre';
}

// ---------------------------------------------------------------------------
// 5. MACRO + REGIME ENVIRONMENT (shared by every company; ~real-history flavor)
// ---------------------------------------------------------------------------
//                 2004  05    06    07    08     09     10    11    12    13    14    15     16    17    18     19    20     21    22     23
const MACRO_EARN = [0.1, 0.09, 0.1, 0.03, -0.22, -0.05, 0.22, 0.12, 0.06, 0.07, 0.06, -0.02, 0.02, 0.11, 0.16, 0.03, -0.13, 0.4, 0.06, 0.04];
const MARKET_MULT = [0.0, -0.02, 0.03, -0.01, -0.22, 0.28, -0.03, -0.09, 0.1, 0.18, 0.05, -0.02, 0.07, 0.09, -0.16, 0.22, 0.24, -0.03, -0.2, 0.16];
// Quality premium per year (negative = "junk rally": low-quality outperforms).
const QUALITY_FACTOR = [0.02, 0.0, -0.02, 0.04, 0.11, -0.13, -0.01, 0.06, 0.02, -0.02, 0.03, 0.05, -0.03, -0.04, 0.06, -0.02, -0.07, -0.11, 0.1, 0.0];
// Value premium per year (negative = growth/expensive wins).
const VALUE_FACTOR = [0.03, 0.02, 0.02, -0.02, -0.04, 0.05, 0.0, -0.02, 0.03, 0.0, -0.02, -0.05, 0.06, -0.06, -0.04, -0.07, -0.11, 0.04, 0.14, -0.03];
// Change in policy rate (+ = hiking). Drives sector-specific multiple pressure.
const RATE_CHANGE = [0.01, 0.02, 0.02, 0.0, -0.04, -0.02, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.01, 0.02, -0.01, -0.015, 0.0, 0.04, 0.01];

/** Explicit sector booms/busts layered on small idiosyncratic sector noise. */
function buildSectorSentiment(r) {
  const out = {};
  const bump = (arr, year, val) => {
    arr[idxOf(year)] += val;
  };
  for (const s of SECTORS) {
    const arr = Array.from({ length: N_YEARS }, () => 0.025 * gauss(r));
    switch (s.sector) {
      case 'Energy & Materials':
        [2005, 2006, 2007].forEach((y) => bump(arr, y, 0.08));
        bump(arr, 2008, -0.12);
        [2014, 2015, 2016, 2017, 2018, 2019, 2020].forEach((y) => bump(arr, y, -0.07));
        bump(arr, 2021, 0.14); bump(arr, 2022, 0.12); bump(arr, 2023, -0.06);
        break;
      case 'Technology':
      case 'Communication Services':
        [2009, 2010, 2011, 2012, 2013].forEach((y) => bump(arr, y, 0.05));
        bump(arr, 2017, 0.06); bump(arr, 2020, 0.1); bump(arr, 2021, 0.08);
        bump(arr, 2022, -0.16); bump(arr, 2023, 0.12);
        break;
      case 'Financials':
        bump(arr, 2008, -0.3); bump(arr, 2009, 0.12); bump(arr, 2011, -0.1);
        bump(arr, 2021, 0.06); bump(arr, 2022, 0.04); bump(arr, 2023, -0.05);
        break;
      case 'Consumer Discretionary':
        bump(arr, 2008, -0.14); bump(arr, 2009, 0.12); bump(arr, 2020, -0.06); bump(arr, 2021, 0.06);
        break;
      case 'Industrials':
        bump(arr, 2008, -0.11); bump(arr, 2009, 0.09); bump(arr, 2020, -0.05);
        break;
      default:
        break;
    }
    out[s.sector] = arr;
  }
  return out;
}

function buildEnvironment(r) {
  return {
    years: Array.from({ length: N_YEARS }, (_, i) => START_YEAR + i),
    marketEarnings: MACRO_EARN,
    marketMult: MARKET_MULT,
    qualityFactor: QUALITY_FACTOR,
    valueFactor: VALUE_FACTOR,
    rateChange: RATE_CHANGE,
    sectorSent: buildSectorSentiment(r),
  };
}

// ---------------------------------------------------------------------------
// Build one company's full multi-year record using the shared environment.
// ---------------------------------------------------------------------------
function buildCompany(i, r, env) {
  const archName = pickArchetype(r);
  const arch = ARCHETYPES[archName];
  const sec = SECTORS[Math.floor(r() * SECTORS.length)];
  const q = lerp(arch.q[0], arch.q[1], r());
  const ticker = `SYN${String(i).padStart(3, '0')}`;
  const growthiness = clamp(sec.growthiness + 0.2 * gauss(r), 0, 1);

  // 3. Fat-tailed mega-winner: a few high-quality names get persistent extreme
  //    compounding + multiple expansion. Identifiable only PARTIALLY ex-ante.
  const moonshot = ['winner', 'solid'].includes(archName) && r() < 0.07;

  // Scheduled delistings (bankrupt/merged); blowups can also delist below.
  let delistYear = null;
  if (archName === 'bankrupt') delistYear = START_YEAR + 6 + Math.floor(r() * 12);
  if (archName === 'merged') delistYear = START_YEAR + 8 + Math.floor(r() * 10);

  // Fundamentals scale.
  let revenue = lerp(2e9, 5e10, r());
  let shares = lerp(2e8, 2e9, r());
  let equity = revenue * lerp(0.4, 0.9, r());
  let debt = equity * lerp(0.1, 2.2, 1 - q) * (0.6 + 0.8 * r());
  let cash = revenue * lerp(0.03, 0.18, q);

  // 2. Valuation multiple model. "Fair" P/E rises with quality & growth.
  const fairAnchor = 9 + 16 * q + 9 * growthiness; // ~ 9..34
  let multiple = clamp(fairAnchor * lerp(0.7, 1.3, r()), 5, 60);
  let prevPrice = null;

  const annual = [];
  let blewUp = false;
  for (let y = START_YEAR; y <= END_YEAR; y++) {
    const k = idxOf(y);
    const macroE = env.marketEarnings[k];
    const macroM = env.marketMult[k];
    const qf = env.qualityFactor[k];
    const vf = env.valueFactor[k];
    const rc = env.rateChange[k];
    const ssent = env.sectorSent[sec.sector][k];

    // --- Fundamentals respond to the macro earnings cycle (sector-scaled) ---
    const baseG = lerp(-0.05, 0.085, q) + arch.growthTilt + (moonshot ? 0.06 : 0);
    const revGrowth = baseG + sec.cyclicality * macroE * 0.55 + 0.04 * gauss(r);
    revenue = Math.max(1e8, revenue * (1 + revGrowth));

    const opMargin = Math.max(
      -0.15,
      sec.marginBase * lerp(0.5, 1.4, q) +
        0.03 * gauss(r) +
        sec.cyclicality * macroE * 0.12 - // margins compress in recessions
        (archName === 'bankrupt' ? 0.12 : 0),
    );
    const operatingIncome = revenue * opMargin;
    const da = revenue * lerp(0.03, 0.08, r());
    const ebitda = operatingIncome + da;
    const interestExpense = debt * lerp(0.03, 0.07, r());
    const pretax = operatingIncome - interestExpense;
    const taxRate = 0.21;
    const tax = Math.max(0, pretax) * taxRate;
    const netIncome = pretax - tax;
    const capex = -(revenue * lerp(0.03, 0.09, 1 - q * 0.5));
    const operatingCashFlow = netIncome + da + revenue * 0.01 * gauss(r);
    const ownerEarnings = netIncome + da - Math.min(Math.abs(capex), da);

    // Balance sheet & shares evolve.
    equity += netIncome * 0.6;
    debt *= archName === 'bankrupt' || archName === 'decline' ? lerp(1.02, 1.12, 1 - q) : lerp(0.95, 1.01, q);
    cash = Math.max(revenue * 0.02, cash + ownerEarnings * lerp(0.1, 0.4, q) + capex * 0.2);
    shares *= q > 0.7 ? lerp(0.97, 0.995, r()) : q < 0.4 ? lerp(1.01, 1.05, r()) : lerp(0.998, 1.01, r());
    const eps = netIncome / shares;

    // --- 1,2,5: multiple re-rating from regimes, rotation, rates, reversion ---
    const fair = clamp(fairAnchor * (1 + 2.2 * Math.max(0, revGrowth - 0.03)), 5, 70);
    const cheap = clamp((fair - multiple) / fair, -1, 1); // >0 means trading below fair
    const reversion = 0.12 * (fair / multiple - 1);
    const rateEffect = -rc * sec.rateSens * 1.8 * (multiple / 22); // hikes compress rich multiples
    const qualityEffect = qf * (q - 0.5) * 0.9; // quality regime (can be negative)
    const valueEffect = vf * cheap * 0.9; // value regime (can be negative)
    const moonEffect = moonshot ? 0.05 + 0.04 * r() : 0;
    const multChange =
      reversion + macroM + ssent + qualityEffect + valueEffect + rateEffect + moonEffect + 0.035 * gauss(r);
    multiple = clamp(multiple * (1 + multChange), 3, 140);

    // --- Price = EPS × multiple, with a price/sales fallback for loss-makers ---
    let price;
    if (eps > 0) {
      price = eps * multiple;
    } else {
      const ps = clamp(0.4 + q + 0.5 * growthiness, 0.2, 4);
      const fallback = (revenue / shares) * ps * (1 + macroM);
      price = prevPrice ? lerp(prevPrice * (1 + macroM - 0.05), fallback, 0.5) : fallback;
    }

    // Bound ordinary annual moves to a realistic range (stocks rarely 2x or halve
    // in a year absent a discrete event); genuine blowups/delistings bypass this.
    if (prevPrice) price = clamp(price, prevPrice * 0.5, prevPrice * 1.9);

    // --- 4: sudden, fundamentals-independent blowup (fraud / liquidity / shock) ---
    if (!delistYear && !blewUp && r() < 0.004) {
      price *= lerp(0.06, 0.5, r());
      blewUp = true;
      if (r() < 0.5) delistYear = y; // some blowups are terminal
    }

    // Scheduled delisting outcome realized in its final year.
    if (delistYear && y === delistYear) {
      if (archName === 'bankrupt') price = Math.max(0.02, price * 0.04);
      else if (archName === 'merged') price = price * (1.2 + 0.35 * r()); // acquisition premium
    }

    price = Math.max(0.02, price);

    annual.push({
      fiscalYear: y,
      asOf: `${y + 1}-03-01`,
      revenue,
      netIncome,
      operatingIncome,
      pretaxIncome: pretax,
      incomeTax: tax,
      taxRate,
      depreciationAmortization: da,
      ebitda,
      operatingCashFlow,
      capex,
      interestExpense,
      totalEquity: equity,
      cash,
      totalAssets: equity + debt + cash,
      totalDebt: debt,
      sharesOutstanding: shares,
      epsDiluted: eps,
      price,
    });

    prevPrice = price;
    if (delistYear && y >= delistYear) break;
  }

  // Re-label outcome if a blowup ended an otherwise-healthy company.
  let outcome = archName;
  if (blewUp && !['bankrupt', 'merged'].includes(archName)) outcome = 'blowup';

  return {
    ticker,
    name: `Synthetic ${sec.sector} Co ${i}`,
    sector: sec.sector,
    industry: `${sec.sector} (synthetic)`,
    cyclicalTheme: sec.theme,
    outcome,
    moonshot,
    delistedYear: delistYear,
    annual,
  };
}

/**
 * Derive benchmark index returns from the realized returns of the universe,
 * CAP-WEIGHTED (weight = prior-year market cap = price × shares). This mirrors a
 * real index: failing names shrink out of the benchmark while winners dominate
 * it — a far harder, more honest bar than equal-weighting zombie microcaps.
 */
function deriveBenchmarks(companies) {
  const byYear = companies.map((c) => {
    const m = {};
    for (const a of c.annual) m[a.fiscalYear] = { price: a.price, shares: a.sharesOutstanding };
    return m;
  });
  const sp = [];
  const nq = [];
  const NASDAQ_SECTORS = new Set(['Technology', 'Communication Services', 'Consumer Discretionary']);

  const capWeighted = (year, filterFn) => {
    let wRetSum = 0;
    let wSum = 0;
    for (let i = 0; i < companies.length; i++) {
      if (filterFn && !filterFn(companies[i])) continue;
      const a0 = byYear[i][year - 1];
      const a1 = byYear[i][year];
      if (a0?.price > 0 && a1?.price > 0) {
        const cap = a0.price * (a0.shares || 1); // prior-year cap = the weight
        wRetSum += cap * (a1.price / a0.price - 1);
        wSum += cap;
      }
    }
    return wSum > 0 ? wRetSum / wSum : 0;
  };

  for (let y = START_YEAR + 1; y <= END_YEAR; y++) {
    sp.push({ year: y, return: round(capWeighted(y, null), 4) });
    nq.push({ year: y, return: round(capWeighted(y, (c) => NASDAQ_SECTORS.has(c.sector)), 4) });
  }
  return { SP500: sp, NASDAQ100: nq };
}

const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** Generate the full universe (deterministic for a given seed). */
export function generateUniverse(seed = 12345, nCompanies = 120) {
  const r = rng(seed);
  const env = buildEnvironment(r);
  const companies = [];
  for (let i = 1; i <= nCompanies; i++) companies.push(buildCompany(i, r, env));

  const benchmarks = deriveBenchmarks(companies);

  const outcomeCounts = companies.reduce((acc, c) => {
    acc[c.outcome] = (acc[c.outcome] || 0) + 1;
    return acc;
  }, {});
  const moonshots = companies.filter((c) => c.moonshot).length;

  return {
    meta: {
      synthetic: true,
      seed,
      startYear: START_YEAR,
      endYear: END_YEAR,
      nCompanies,
      outcomeCounts,
      moonshots,
      dynamicsModeled: [
        'factor regime shifts (quality/value premia go negative for stretches)',
        'multiple expansion/compression (price = EPS x evolving P/E)',
        'fat-tailed mega-winners (power-law compounders)',
        'sudden fundamentals-independent blowups',
        'sector rotation & a shared macro/rate cycle',
      ],
      disclaimer:
        'ILLUSTRATIVE synthetic data — not real market history. Models real-market dynamics (factor regimes, multiple re-rating, fat-tailed winners, blowups, sector rotation) and deliberately includes losers/delistings to fight survivorship bias. Benchmarks are derived from the universe itself. See docs/limitations.md.',
      generatedAt: new Date().toISOString(),
    },
    benchmarks,
    companies,
  };
}

/** Load the cached universe from disk, generating + persisting it on first use. */
export function loadUniverse() {
  try {
    if (fs.existsSync(SAMPLE_PATH)) {
      return JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
    }
  } catch (err) {
    logger.warn(`Could not read sample universe, regenerating: ${err.message}`);
  }
  const universe = generateUniverse();
  fs.mkdirSync(path.dirname(SAMPLE_PATH), { recursive: true });
  fs.writeFileSync(SAMPLE_PATH, JSON.stringify(universe));
  logger.info(`Generated synthetic universe (${universe.companies.length} companies) -> ${SAMPLE_PATH}`);
  return universe;
}

export { START_YEAR, END_YEAR };
