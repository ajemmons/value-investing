/**
 * Fetch a broad large-cap US constituent list and write it to
 * data/universe/russell1000.json (consumed by the portfolio builder).
 *
 *   node backend/scripts/fetchUniverse.js              # S&P 500 + 400 + 600 (~1500)
 *   node backend/scripts/fetchUniverse.js --sp900      # S&P 500 + 400 only (~900)
 *   node backend/scripts/fetchUniverse.js ./IWB.csv    # parse a local iShares CSV
 *
 * HONESTY: SEC does not publish index membership and the iShares Russell 1000
 * (IWB) holdings endpoint now serves a bot-wall instead of a CSV. So by default
 * we use Wikipedia's S&P index constituent tables — a free, stable source. By
 * default we take the full S&P Composite 1500 (S&P 500 large + 400 mid + 600
 * small cap) — a ~1,500-name superset that fully covers the Russell 1000's names
 * and then some. Pass `--sp900` for just the large/mid-cap 900 if you want a
 * tighter, faster set. This is a CURRENT-universe screen, not point-in-time
 * membership.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'universe', 'russell1000.json');

const WIKI_PAGES = {
  'S&P 500': 'List_of_S%26P_500_companies',
  'S&P 400': 'List_of_S%26P_400_companies',
  'S&P 600': 'List_of_S%26P_600_companies',
};

/** Extract tickers from a Wikipedia constituents-table wikitext blob. */
function parseWikitext(wt) {
  const set = new Set();
  let m;
  // Symbols are wrapped in exchange templates, e.g. {{NyseSymbol|MMM}} / {{NasdaqSymbol|AAPL}}.
  const reTpl = /\{\{[A-Za-z. ]*[Ss]ymbol[^|}]*\|\s*([A-Z][A-Z.]{0,5})\s*\}\}/g;
  while ((m = reTpl.exec(wt))) set.add(m[1]);
  // Some rows link the symbol directly, e.g. [[NASDAQ:AAPL|AAPL]].
  const reLink = /\[\[(?:NASDAQ|New York Stock Exchange|NYSE|Nasdaq)[^\]|]*\|\s*([A-Z][A-Z.]{0,5})\s*\]\]/g;
  while ((m = reLink.exec(wt))) set.add(m[1]);
  return [...set];
}

async function fetchWikiList(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&page=${page}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'BuffettGrahamEvaluator/1.0 (educational)' } });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for ${page}`);
  const json = await res.json();
  const wt = json?.parse?.wikitext?.['*'];
  if (!wt) throw new Error(`No wikitext returned for ${page}`);
  return parseWikitext(wt);
}

/** Minimal CSV parser for the manual iShares-CSV fallback. */
function parseIsharesCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^"?Ticker"?,/.test(l));
  if (headerIdx === -1) throw new Error('No "Ticker" header row found — is this an iShares holdings CSV?');
  const out = new Set();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const first = (lines[i].split(',')[0] || '').replace(/"/g, '').trim().toUpperCase();
    if (/^[A-Z]{1,6}([.\-][A-Z]{1,3})?$/.test(first)) out.add(first);
  }
  return [...out];
}

async function main() {
  const localCsv = process.argv.find((a) => a.endsWith('.csv'));
  const sp900 = process.argv.includes('--sp900');

  let tickers;
  let source;
  if (localCsv) {
    console.log(`Parsing local iShares CSV: ${localCsv}`);
    tickers = parseIsharesCsv(fs.readFileSync(localCsv, 'utf8'));
    source = 'iShares holdings CSV (manual)';
  } else {
    const pages = sp900
      ? ['S&P 500', 'S&P 400']
      : ['S&P 500', 'S&P 400', 'S&P 600'];
    console.log(`Fetching ${pages.join(' + ')} constituents from Wikipedia…`);
    const set = new Set();
    for (const name of pages) {
      const list = await fetchWikiList(WIKI_PAGES[name]);
      list.forEach((t) => set.add(t));
      console.log(`  ${name}: ${list.length} tickers`);
    }
    tickers = [...set];
    source = `Wikipedia ${pages.join(' + ')} (proxy for the Russell 1000)`;
  }

  tickers.sort();
  if (tickers.length < 400) {
    console.warn(`⚠ Only parsed ${tickers.length} tickers — source format may have changed.`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(tickers, null, 0));
  console.log(`✓ Wrote ${tickers.length} tickers (${source}) -> ${path.relative(ROOT, OUT)}`);
  console.log(`\nNext: pre-warm the cache (one time):`);
  console.log(`  npm run portfolio -- --full --risk moderate`);
}

main().catch((err) => {
  console.error('fetchUniverse failed:', err.message);
  console.error(
    '\nFallbacks:\n' +
      '  • Retry (Wikipedia can rate-limit): npm run fetch-universe\n' +
      '  • Use a manual iShares CSV: node backend/scripts/fetchUniverse.js /path/to/IWB_holdings.csv\n',
  );
  process.exit(1);
});
