/* ===========================================================================
   Value Lens — frontend application logic (vanilla JS, no build step).
   Talks to the backend API, renders scorecards, diversification, peers, the
   backtest dashboard, and the methodology page.
   =========================================================================== */
'use strict';

const state = {
  risk: 'moderate',
  weights: null,
  rebalancing: null,
};

// ---- tiny helpers ----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x, d = 2) => (isNum(x) ? x.toFixed(d) : x === Infinity ? '∞' : '—');
const money = (x) => {
  if (!isNum(x)) return '—';
  const abs = Math.abs(x);
  if (abs >= 1e12) return `$${(x / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  return `$${x.toFixed(2)}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function scoreColor(score) {
  if (!isNum(score)) return 'var(--muted)';
  if (score >= 80) return 'var(--excellent)';
  if (score >= 65) return 'var(--accent)';
  if (score >= 50) return 'var(--ok)';
  if (score >= 35) return 'var(--warn)';
  return 'var(--bad)';
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data;
}

// ---- tab switching ---------------------------------------------------------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'backtest') loadBacktest();
    if (tab.dataset.tab === 'methodology') renderMethodology();
  });
});

// ---- risk selector (global; keeps every selector on the page in sync) ------
function setRisk(risk) {
  state.risk = risk;
  $$('.risk-btn').forEach((b) => b.classList.toggle('active', b.dataset.risk === risk));
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.risk-btn');
  if (!btn) return;
  setRisk(btn.dataset.risk);
});

// ---- analyze / screen actions ---------------------------------------------
$('#analyzeBtn').addEventListener('click', runAnalyze);
$('#screenBtn').addEventListener('click', runScreen);
$('#tickerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAnalyze();
});

function collectKeys() {
  const keys = {};
  const fmp = $('#key-fmp').value.trim();
  const av = $('#key-alphaVantage').value.trim();
  if (fmp) keys.fmp = fmp;
  if (av) keys.alphaVantage = av;
  return keys;
}

function setStatus(html, isError = false) {
  const el = $('#analyzeStatus');
  if (!html) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status${isError ? ' error' : ''}`;
  el.innerHTML = html;
}

function clearResults() {
  $('#results').innerHTML = '';
  $('#diversificationPanel').innerHTML = '';
  $('#peerPanel').innerHTML = '';
  $('#screenResults').innerHTML = '';
}

async function runAnalyze() {
  const tickers = $('#tickerInput').value.trim();
  if (!tickers) {
    setStatus('Enter at least one ticker, e.g. <code>AAPL, KO, JNJ</code>.', true);
    return;
  }
  clearResults();
  setStatus(`<span class="spinner"></span> Analyzing for a <strong>${state.risk}</strong> investor…`);
  $('#analyzeBtn').disabled = true;
  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, riskLevel: state.risk, keys: collectKeys() }),
    });
    setStatus(
      `Analyzed <strong>${data.summary.analyzed}</strong> of ${data.requested.length}` +
        (data.summary.failed ? ` · ${data.summary.failed} failed` : '') +
        (data.summary.avgScore != null ? ` · avg score <strong>${data.summary.avgScore}</strong>` : '') +
        (data.invalid?.length ? ` · ignored invalid: ${data.invalid.map(esc).join(', ')}` : ''),
    );
    renderDiversification(data.diversification);
    renderPeers(data.peers, data.results.filter((r) => r.ok));
    renderResults(data.results);
  } catch (err) {
    setStatus(`Error: ${esc(err.message)}`, true);
  } finally {
    $('#analyzeBtn').disabled = false;
  }
}

async function runScreen() {
  clearResults();
  const tickers = $('#tickerInput').value.trim();
  setStatus(`<span class="spinner"></span> Screening universe for a <strong>${state.risk}</strong> investor…`);
  $('#screenBtn').disabled = true;
  try {
    const data = await api('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, riskLevel: state.risk, keys: collectKeys() }),
    });
    setStatus(`Screened <strong>${data.universeSize}</strong> tickers · ranked by ${state.risk} score.`);
    renderDiversification(data.diversification);
    renderScreen(data);
  } catch (err) {
    setStatus(`Error: ${esc(err.message)}`, true);
  } finally {
    $('#screenBtn').disabled = false;
  }
}

// ---- rendering: scorecards -------------------------------------------------
function renderResults(results) {
  const root = $('#results');
  root.innerHTML = '';
  results.forEach((r) => root.appendChild(r.ok ? scorecard(r) : failedCard(r)));
}

function failedCard(r) {
  const div = document.createElement('div');
  div.className = 'scorecard failed';
  div.innerHTML = `<div class="scorecard-head"><div><h3>${esc(r.ticker)}</h3>
    <div class="sub">Could not analyze</div></div></div>
    <hr class="divider"/>
    <p class="muted">${esc(r.error?.message || 'Unknown error')}</p>
    <p class="small muted">Code: ${esc(r.error?.code || 'ERROR')}. The company may be non-US, recently listed, or missing XBRL data in SEC EDGAR.</p>`;
  return div;
}

function scorecard(r) {
  const div = document.createElement('div');
  div.className = 'scorecard';
  const ratingClass = 'rating-' + (r.rating || 'Insufficient').split(' ')[0];

  div.innerHTML = `
    <div class="scorecard-head">
      <div>
        <h3>${esc(r.name || r.ticker)} <span class="muted">(${esc(r.ticker)})</span></h3>
        <div class="sub">${esc(r.sector || 'Unknown')} · ${esc(r.industry || '')}${
          isNum(r.price) ? ` · ${money(r.price)}` : ''
        }${r.marketCap ? ` · ${money(r.marketCap)} cap` : ''}</div>
        <div class="sub">FY${r.latestFiscalYear ?? '—'} data${
          r.priceSource && r.priceSource !== 'none' ? ` · price via ${esc(r.priceSource)}` : ' · no live price'
        }</div>
      </div>
      <div class="score-badge">
        <div class="score-num" style="color:${scoreColor(r.score)}">${r.score ?? '—'}</div>
        <div class="rating-pill ${ratingClass}">${esc(r.rating)}</div>
      </div>
    </div>

    ${strengthsWeaknesses(r)}
    <hr class="divider"/>
    <h4>Metric breakdown <span class="muted small">(weighted for ${esc(r.riskLevel)})</span></h4>
    ${r.breakdown.map(metricRow).join('')}

    <hr class="divider"/>
    ${valuationBlock(r.valuation)}

    <hr class="divider"/>
    <h4>Key figures</h4>
    ${metricsTable(r.metrics)}

    ${dataQualityNote(r)}
  `;
  return div;
}

function strengthsWeaknesses(r) {
  if (!r.strengths?.length && !r.weaknesses?.length) return '';
  const s = (r.strengths || []).map((x) => `<span class="tag good">▲ ${esc(x.label)} (${x.score})</span>`).join('');
  const w = (r.weaknesses || []).map((x) => `<span class="tag bad">▼ ${esc(x.label)} (${x.score})</span>`).join('');
  return `<div class="tag-list">${s}${w}</div>`;
}

function metricRow(b) {
  const has = b.available && isNum(b.score);
  const color = scoreColor(b.score);
  return `
    <div class="metric-row ${has ? '' : 'na'}">
      <div class="top">
        <span class="label">${esc(b.label)}<span class="w">w ${(b.effectiveWeight * 100).toFixed(0)}%</span></span>
        <span class="val">${has ? b.score : 'N/A'}</span>
      </div>
      <div class="bar"><span style="width:${has ? b.score : 0}%;background:${color}"></span></div>
      <div class="metric-note">${esc(b.note || '')}</div>
    </div>`;
}

function valuationBlock(v) {
  if (!v) return '<h4>Valuation</h4><p class="muted">Unavailable.</p>';
  const mos = v.marginOfSafety;
  const mosClass = isNum(mos) ? (mos >= 0 ? 'mos-pos' : 'mos-neg') : '';
  const a = v.assumptions || {};
  return `
    <h4>Intrinsic value (DCF on ${esc(v.baseSource || 'cash flow')})</h4>
    <div class="val-grid">
      <div class="val-cell"><div class="k">Conservative</div><div class="v">${money(v.scenarios?.conservative)}</div></div>
      <div class="val-cell"><div class="k">Base</div><div class="v">${money(v.scenarios?.base)}</div></div>
      <div class="val-cell"><div class="k">Aggressive</div><div class="v">${money(v.scenarios?.aggressive)}</div></div>
    </div>
    <div class="val-grid">
      <div class="val-cell"><div class="k">Price</div><div class="v">${money(v.price)}</div></div>
      <div class="val-cell"><div class="k">Margin of safety</div><div class="v ${mosClass}">${
        v.marginCapped ? '&ge;200%*' : pct(mos, 0)
      }</div></div>
      <div class="val-cell"><div class="k">P/E context</div><div class="v" style="font-size:0.8rem">${
        isNum(v.peContext?.pe) ? `${num(v.peContext.pe, 1)} vs ~${v.peContext.sectorPe}` : '—'
      }</div></div>
    </div>
    ${v.peContext?.summary ? `<p class="small muted">${esc(v.peContext.summary)}</p>` : ''}
    ${v.marginCapped ? `<p class="small muted">*DCF implies a very large discount; capped for display — DCFs are highly assumption-sensitive, so verify before trusting.</p>` : ''}
    <ul class="assumption-list">
      <li>Discount rate ${pct(a.discountRate, 1)} · terminal growth ${pct(a.terminalGrowth, 1)} · ${a.years || 10}-yr stage 1</li>
      <li>${esc(a.note || '')}</li>
    </ul>`;
}

function metricsTable(m) {
  if (!m) return '';
  const rows = [
    ['ROIC', pct(m.roic), m.roic == null],
    ['ROE', pct(m.roe), m.roe == null],
    ['FCF growth (CAGR)', pct(m.fcfCagr), m.fcfCagr == null],
    ['Owner earnings CAGR', pct(m.ownerEarningsCagr), m.ownerEarningsCagr == null],
    ['Avg operating margin', pct(m.operatingMarginAvg), m.operatingMarginAvg == null],
    ['Debt / equity', num(m.debtToEquity), m.debtToEquity == null],
    ['Net debt / EBITDA', num(m.netDebtToEbitda), m.netDebtToEbitda == null],
    ['Interest coverage', num(m.interestCoverage, 1) + (m.interestCoverage === Infinity ? '' : 'x'), m.interestCoverage == null],
    ['Earnings positive yrs', pct(m.earningsPositiveRatio, 0), m.earningsPositiveRatio == null],
    ['Share count trend / yr', pct(m.shareCountTrend), m.shareCountTrend == null],
    ['P/E', num(m.pe, 1), m.pe == null],
  ];
  return `<table class="mini-table">${rows
    .map(([k, v, missing]) => `<tr><td>${k}${missing ? ' <span class="estimated">(n/a)</span>' : ''}</td><td>${v}</td></tr>`)
    .join('')}</table>`;
}

function dataQualityNote(r) {
  const dq = r.dataQuality;
  if (!dq) return '';
  const cov = r.coverage;
  const warn = dq.completeness < 0.8 || !dq.sufficient;
  return `<p class="small muted" style="margin-top:0.7rem">
    Data: ${dq.yearsAvailable} yrs · ${(dq.completeness * 100).toFixed(0)}% complete · scored ${
      cov?.metricsScored ?? '?'
    }/${cov?.metricsTotal ?? 10} metrics${
      warn ? ' · <span class="estimated">⚠ some metrics estimated/missing</span>' : ''
    }</p>`;
}

// ---- rendering: diversification -------------------------------------------
function renderDiversification(d) {
  renderDiversificationInto($('#diversificationPanel'), d);
}

function renderDiversificationInto(root, d) {
  if (!root) return;
  if (!d || d.count === 0) {
    root.innerHTML = '';
    return;
  }
  const bars = Object.entries(d.sectors || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([sec, share]) => `<div class="sector-bar">
        <span class="name">${esc(sec)}</span>
        <span class="track"><span style="width:${(share * 100).toFixed(0)}%"></span></span>
        <span class="pct">${(share * 100).toFixed(0)}%</span>
      </div>`,
    )
    .join('');
  const warnings = d.warnings?.length
    ? d.warnings.map((w) => `<div class="warn-box">⚠ ${esc(w)}</div>`).join('')
    : `<div class="ok-box">✓ No major sector-concentration warnings for this selection.</div>`;
  const suggestions = d.suggestions?.length
    ? `<p class="small muted">${d.suggestions.map(esc).join(' ')}</p>`
    : '';
  root.innerHTML = `<div class="panel">
    <h3>Diversification</h3>
    <p class="small muted">${d.count} companies · ${
      d.effectiveSectors ?? '—'
    } effective sectors (HHI ${num(d.hhi, 2)}). Lower concentration = lower single-theme risk.</p>
    ${warnings}
    ${suggestions}
    <div class="sector-bars">${bars}</div>
  </div>`;
}

// ---- rendering: peers ------------------------------------------------------
function renderPeers(peers, okResults) {
  const root = $('#peerPanel');
  if (!peers || !okResults?.length || Object.keys(peers.bySector || {}).length === 0) {
    root.innerHTML = '';
    return;
  }
  const fmt = { roic: pct, roe: pct, operatingMarginAvg: pct, fcfCagr: pct, debtToEquity: (x) => num(x), pe: (x) => num(x, 1) };
  const labels = {
    roic: 'ROIC',
    roe: 'ROE',
    operatingMarginAvg: 'Op margin',
    fcfCagr: 'FCF CAGR',
    debtToEquity: 'D/E',
    pe: 'P/E',
  };
  const head = peers.fields.map((f) => `<th class="num">${labels[f]}</th>`).join('');
  const rows = Object.entries(peers.bySector)
    .map(
      ([sec, b]) => `<tr><td><strong>${esc(sec)}</strong> <span class="muted">(${b.count})</span></td>${peers.fields
        .map((f) => `<td class="num">${fmt[f](b.averages[f])}</td>`)
        .join('')}</tr>`,
    )
    .join('');
  const groupRow = `<tr><td><strong>Group avg</strong></td>${peers.fields
    .map((f) => `<td class="num">${fmt[f](peers.group[f])}</td>`)
    .join('')}</tr>`;
  root.innerHTML = `<div class="panel">
    <h3>Peer &amp; sector averages</h3>
    <p class="small muted">Averages across the analyzed group, by sector. Use to judge whether a company's P/E and returns are rich or cheap relative to peers.</p>
    <table class="data-table"><thead><tr><th>Sector</th>${head}</tr></thead>
    <tbody>${rows}${groupRow}</tbody></table>
  </div>`;
}

// ---- rendering: screen results --------------------------------------------
function renderScreen(data) {
  const root = $('#screenResults');
  if (!data.ranked?.length) {
    root.innerHTML = '<div class="empty">No companies could be ranked.</div>';
    return;
  }
  const rows = data.ranked
    .map(
      (r, i) => `<tr>
      <td>${i + 1}</td>
      <td><strong>${esc(r.ticker)}</strong><br><span class="muted small">${esc(r.name || '')}</span></td>
      <td>${esc(r.sector || '')}</td>
      <td class="num" style="color:${scoreColor(r.score)};font-weight:650">${r.score ?? '—'}</td>
      <td><span class="rating-pill rating-${(r.rating || 'Insufficient').split(' ')[0]}">${esc(r.rating)}</span></td>
      <td class="num ${isNum(r.marginOfSafety) && r.marginOfSafety >= 0 ? 'pos' : 'neg'}">${pct(r.marginOfSafety, 0)}</td>
      <td class="num">${money(r.price)}</td>
    </tr>`,
    )
    .join('');
  const failed = data.failed?.length
    ? `<p class="small muted">Could not analyze: ${data.failed.map((f) => esc(f.ticker)).join(', ')}.</p>`
    : '';
  root.innerHTML = `<div class="panel">
    <h3>Screen results — ranked by ${esc(data.riskLevel)} score</h3>
    <table class="data-table">
      <thead><tr><th>#</th><th>Company</th><th>Sector</th><th class="num">Score</th><th>Rating</th><th class="num">Margin of safety</th><th class="num">Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${failed}
  </div>`;
}

// ---- 12-stock portfolio builder -------------------------------------------
$('#buildPortfolioBtn').addEventListener('click', buildPortfolio);

// On load, ask the server whether the full large-cap universe has been loaded.
// Builds always evaluate the full universe; this just updates the hint copy
// (and surfaces the pre-warm instructions if the list isn't loaded yet).
(async function initFullUniverse() {
  try {
    const cfg = await api('/api/config');
    const u = cfg?.universe || {};
    const hint = $('#fullUniverseHint');
    const buildHint = $('#buildHint');
    if (u.fullAvailable) {
      if (hint) hint.hidden = true;
      if (buildHint) {
        buildHint.textContent = `Evaluates the full large-cap universe (${u.fullCount} constituents) — may take 1–2 minutes (cached after).`;
      }
    } else if (buildHint) {
      buildHint.textContent = `Evaluates ${u.subset || '~195'} companies — the full ~1,500-name universe isn't loaded yet (see below).`;
    }
  } catch {
    /* non-fatal: leave the default hint copy in place */
  }
})();

function setPortfolioStatus(html, isError = false) {
  const el = $('#portfolioStatus');
  if (!html) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status${isError ? ' error' : ''}`;
  el.innerHTML = html;
}

async function buildPortfolio() {
  $('#portfolioSummary').innerHTML = '';
  $('#portfolioDiversification').innerHTML = '';
  $('#portfolioResults').innerHTML = '';
  // Always evaluate the full large-cap universe, unless the user pasted a custom list.
  const customUniverse = $('#portfolioUniverse').value.trim();
  const scope = customUniverse ? 'your custom universe' : 'the full large-cap universe';
  setPortfolioStatus(
    `<span class="spinner"></span> Screening ${scope} for a <strong>${state.risk}</strong> investor… ` +
      `<span class="small">(this can take 1–2 minutes; results are cached after)</span>`,
  );
  $('#buildPortfolioBtn').disabled = true;
  try {
    const data = await api('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        riskLevel: state.risk,
        size: 12,
        perSector: 3,
        full: !customUniverse,
        universe: customUniverse || undefined,
        keys: collectKeys(),
      }),
    });
    setPortfolioStatus(
      `Evaluated <strong>${data.evaluated}</strong> companies from ${esc(data.universe.name)} · ` +
        `${data.analyzed} scored · ${data.failed} unavailable.` +
        (data.guardrailApplied && data.riskLevel !== 'aggressive'
          ? ` ${data.riskLevel} guardrails excluded "Avoid"-rated and data-poor names.`
          : ''),
    );
    renderPortfolio(data);
  } catch (err) {
    setPortfolioStatus(`Error: ${esc(err.message)}`, true);
  } finally {
    $('#buildPortfolioBtn').disabled = false;
  }
}

function renderPortfolio(data) {
  // Summary + sector distribution chips.
  const sectorChips = Object.entries(data.sectorCount || {})
    .sort((a, b) => b[1] - a[1])
    .map(([sec, n]) => `<span class="tag">${esc(sec)} · ${n}</span>`)
    .join('');
  $('#portfolioSummary').innerHTML = `<div class="panel">
    <h3>${data.portfolio.length}-stock ${esc(data.riskLevel)} portfolio</h3>
    <p class="small muted">Average score <strong>${data.avgScore ?? '—'}</strong> ·
      max ${data.perSector} per sector ·
      recommended rebalancing <strong class="recommended">${esc(data.recommendedRebalance)}</strong>
      (from backtest).</p>
    <div class="tag-list">${sectorChips}</div>
  </div>`;

  // Diversification panel (reuse the renderer into the portfolio container).
  const divHost = $('#portfolioDiversification');
  renderDiversificationInto(divHost, data.diversification);

  // Holdings table.
  const rows = data.portfolio
    .map(
      (p) => `<tr>
      <td>${p.rank}</td>
      <td><strong>${esc(p.ticker)}</strong><br><span class="muted small">${esc(p.name || '')}</span></td>
      <td>${esc(p.sector || '')}</td>
      <td class="num" style="color:${scoreColor(p.score)};font-weight:650">${p.score ?? '—'}</td>
      <td><span class="rating-pill rating-${(p.rating || 'Insufficient').split(' ')[0]}">${esc(p.rating)}</span></td>
      <td class="num ${isNum(p.marginOfSafety) && p.marginOfSafety >= 0 ? 'pos' : 'neg'}">${p.marginCapped ? '&ge;200%' : pct(p.marginOfSafety, 0)}</td>
      <td class="num">${money(p.price)}</td>
      <td class="small muted">${esc(p.topStrength || '')}</td>
    </tr>`,
    )
    .join('');

  const alternates = data.alternates?.length
    ? `<div class="panel">
        <h3>Strong names excluded by the 3-per-sector cap</h3>
        <p class="small muted">These scored well but their sector was already full — shown for transparency.</p>
        <div class="tag-list">${data.alternates
          .map((a) => `<span class="tag">${esc(a.ticker)} · ${esc(a.sector)} · ${a.score}</span>`)
          .join('')}</div>
      </div>`
    : '';

  $('#portfolioResults').innerHTML = `<div class="panel">
    <h3>Holdings</h3>
    <table class="data-table">
      <thead><tr><th>#</th><th>Company</th><th>Sector</th><th class="num">Score</th><th>Rating</th><th class="num">Margin of safety</th><th class="num">Price</th><th>Top strength</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>${alternates}`;
}

// ---- backtest dashboard ----------------------------------------------------
let backtestLoaded = false;
async function loadBacktest() {
  if (backtestLoaded) return;
  const root = $('#backtestContent');
  try {
    const data = await api('/api/backtest');
    backtestLoaded = true;
    renderBacktest(data, root);
  } catch (err) {
    root.className = 'status error';
    root.innerHTML = `Could not load backtest report: ${esc(err.message)}<br><span class="small">Run <code>npm run tune</code> in the project to generate it.</span>`;
  }
}

function renderBacktest(data, root) {
  root.className = '';
  const ds = data.dataset || {};
  const cards = ['conservative', 'moderate', 'aggressive']
    .map((rk) => backtestCard(data.riskProfiles[rk]))
    .join('');

  const oc = ds.outcomeCounts || {};
  const outcomeStr = Object.entries(oc).map(([k, v]) => `${v} ${k}`).join(' · ');

  root.innerHTML = `
    <div class="panel">
      <h3>Dataset &amp; benchmarks</h3>
      <p class="small muted">${esc(ds.disclaimer || '')}</p>
      <p class="small">Universe: <strong>${ds.nCompanies || '—'}</strong> companies (${esc(outcomeStr)}) ·
      Years ${ds.startYear}–${ds.endYear} · Benchmarks: ${(data.benchmarks || []).join(', ')}</p>
    </div>
    <div class="bt-grid">${cards}</div>
    <div class="limitations">
      <h3>⚠ Known limitations</h3>
      <ul>${(data.limitations || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>`;
}

function backtestCard(p) {
  if (!p) return '';
  const h = p.headline;
  const ex = p.benchmark?.excessAnnualized;
  const rebRows = (p.rebalanceComparison || [])
    .map(
      (c) => `<tr class="${c.rebalance === p.recommendedRebalance ? 'recommended' : ''}">
      <td>${c.rebalance}${c.rebalance === p.recommendedRebalance ? ' ★' : ''}</td>
      <td class="num">${pct(c.annualizedReturn, 1)}</td>
      <td class="num">${num(c.sharpe, 2)}</td>
      <td class="num">${pct(c.maxDrawdown, 0)}</td>
      <td class="num">${pct(c.avgTurnover, 0)}</td>
    </tr>`,
    )
    .join('');
  const topHoldings = (p.topHoldings || [])
    .slice(0, 5)
    .map((x) => `<tr><td>${esc(x.ticker)}</td><td>${esc(x.sector)}</td><td class="num ${x.avgReturn >= 0 ? 'pos' : 'neg'}">${pct(x.avgReturn, 0)}</td><td>${esc(x.outcome)}</td></tr>`)
    .join('');
  const worstHoldings = (p.worstHoldings || [])
    .slice(0, 4)
    .map((x) => `<tr><td>${esc(x.ticker)}</td><td>${esc(x.sector)}</td><td class="num ${x.avgReturn >= 0 ? 'pos' : 'neg'}">${pct(x.avgReturn, 0)}</td><td>${esc(x.outcome)}</td></tr>`)
    .join('');

  return `<div class="panel">
    <h3 style="text-transform:capitalize">${esc(p.riskLevel)}</h3>
    <p class="small muted">Recommended rebalancing: <strong class="recommended">${esc(p.recommendedRebalance)}</strong> · ${p.topN}-stock portfolio</p>
    <div class="stat-grid">
      <div class="stat"><div class="k">Annualized</div><div class="v">${pct(h.annualizedReturn, 1)}</div></div>
      <div class="stat"><div class="k">vs S&P 500</div><div class="v ${isNum(ex) && ex >= 0 ? 'pos' : 'neg'}">${pct(ex, 1)}</div></div>
      <div class="stat"><div class="k">Max drawdown</div><div class="v neg">${pct(h.maxDrawdown, 0)}</div></div>
      <div class="stat"><div class="k">Volatility</div><div class="v">${pct(h.volatility, 0)}</div></div>
      <div class="stat"><div class="k">Sharpe</div><div class="v">${num(h.sharpe, 2)}</div></div>
      <div class="stat"><div class="k">Sortino</div><div class="v">${num(h.sortino, 2)}</div></div>
      <div class="stat"><div class="k">Win rate</div><div class="v">${pct(h.winRate, 0)}</div></div>
      <div class="stat"><div class="k">Avg turnover</div><div class="v">${pct(h.avgTurnover, 0)}</div></div>
    </div>
    <p class="small muted">Top-2 winner reliance: ${pct(p.winnerRelianceShare, 0)} · held ${p.heldFailuresCount} names that later declined/failed (shown honestly).</p>

    <h4 class="small">Rebalancing comparison</h4>
    <table class="data-table">
      <thead><tr><th>Method</th><th class="num">Ann.</th><th class="num">Sharpe</th><th class="num">MaxDD</th><th class="num">Turn.</th></tr></thead>
      <tbody>${rebRows}</tbody>
    </table>

    <h4 class="small">Top historical holdings</h4>
    <table class="data-table"><thead><tr><th>Ticker</th><th>Sector</th><th class="num">Avg ret</th><th>Outcome</th></tr></thead><tbody>${topHoldings}</tbody></table>
    <h4 class="small">Worst historical holdings</h4>
    <table class="data-table"><thead><tr><th>Ticker</th><th>Sector</th><th class="num">Avg ret</th><th>Outcome</th></tr></thead><tbody>${worstHoldings}</tbody></table>
  </div>`;
}

// ---- methodology -----------------------------------------------------------
const METRIC_DOCS = [
  ['ROIC', 'NOPAT ÷ invested capital. The clearest signal of a durable competitive advantage — high, stable ROIC is the hallmark of a Buffett-quality business.'],
  ['Free cash flow growth', 'Compound annual growth of FCF (operating cash flow − capex), measured between 3-year averaged endpoints so a single peak or trough year can\'t skew the trend, and gated by how often FCF was positive. Growth off a shaky base is discounted.'],
  ['Owner earnings', "Buffett's measure: net income + D&A − maintenance capex. We approximate maintenance capex as the lesser of capex and D&A."],
  ['Operating margin stability', 'Low coefficient of variation in operating margin signals pricing power and predictable economics; a bonus rewards structurally high margins.'],
  ['Debt levels', 'Debt/equity and net-debt/EBITDA combined. Net cash scores best; heavy leverage is penalized regardless of profitability.'],
  ['Interest coverage', 'EBIT ÷ interest expense. High coverage means the business comfortably services its debt even in a downturn.'],
  ['Earnings consistency', 'Share of years with positive earnings, adjusted for steady revenue. Erratic or shrinking earnings are penalized.'],
  ['Share count trend', 'Buybacks (a shrinking share count) reward shareholders; persistent dilution is a red flag.'],
  ['Return on equity', 'Net income ÷ equity, capped so leverage-driven ROE is not over-rewarded (debt is scored separately).'],
  ['Valuation vs intrinsic value', 'Margin of safety from a two-stage DCF, nudged by a CONTEXTUAL P/E read — never rewarding a low P/E or punishing a high one in isolation.'],
];

async function renderMethodology() {
  const root = $('#methodologyContent');
  if (root.dataset.rendered) return;
  try {
    const w = await api('/api/weights');
    state.weights = w.weights;
    state.rebalancing = w.rebalancing;
  } catch {
    /* non-fatal */
  }
  const metricCards = METRIC_DOCS.map(
    ([t, d]) => `<div class="method-metric"><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`,
  ).join('');

  const weightTables = state.weights
    ? ['conservative', 'moderate', 'aggressive']
        .map((rk) => weightTable(rk, state.weights[rk]))
        .join('')
    : '<p class="muted">Weights unavailable.</p>';

  root.innerHTML = `
    <div class="method-section">
      <h3>The ten metrics</h3>
      <div class="method-grid">${metricCards}</div>
    </div>
    <div class="method-section">
      <h3>Risk-level weighting</h3>
      <p class="muted small">Source: ${esc(state.weights ? 'tuned by the backtesting engine' : 'defaults')}.
      Recommended rebalancing — Conservative: <strong>${esc(state.rebalancing?.conservative || '—')}</strong>,
      Moderate: <strong>${esc(state.rebalancing?.moderate || '—')}</strong>,
      Aggressive: <strong>${esc(state.rebalancing?.aggressive || '—')}</strong>.</p>
      ${weightTables}
    </div>
    <div class="method-section">
      <h3>What we deliberately ignore</h3>
      <p class="muted">No price momentum, chart patterns, hype, analyst price targets, or news sentiment.
      Evaluation rests on financial strength, business quality, valuation, and risk-adjusted durability.
      Missing metrics are excluded and the remaining weights renormalized — never silently scored as zero.</p>
    </div>`;
  root.dataset.rendered = '1';
}

function weightTable(risk, weights) {
  if (!weights) return '';
  const rows = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, v]) => `<tr><td>${esc(METRIC_KEY_LABELS[k] || k)}</td><td class="num">${(v * 100).toFixed(0)}%</td>
      <td><span class="track" style="display:inline-block;width:120px;height:8px;background:var(--card-2);border-radius:5px;overflow:hidden;vertical-align:middle">
      <span style="display:block;height:100%;width:${(v * 100 * 3).toFixed(0)}%;background:var(--accent)"></span></span></td></tr>`,
    )
    .join('');
  return `<h4 style="text-transform:capitalize;margin-top:1rem">${esc(risk)}</h4>
    <table class="data-table"><tbody>${rows}</tbody></table>`;
}

const METRIC_KEY_LABELS = {
  roic: 'ROIC',
  fcfGrowth: 'Free cash flow growth',
  ownerEarnings: 'Owner earnings growth',
  marginStability: 'Operating margin stability',
  debt: 'Debt levels',
  interestCoverage: 'Interest coverage',
  earningsConsistency: 'Earnings consistency',
  shareCount: 'Share count trend',
  roe: 'Return on equity',
  valuation: 'Valuation vs intrinsic value',
};

// ---- boot ------------------------------------------------------------------
(async function init() {
  try {
    const w = await api('/api/weights');
    state.weights = w.weights;
    state.rebalancing = w.rebalancing;
  } catch {
    /* server may still be starting; non-fatal */
  }
})();
