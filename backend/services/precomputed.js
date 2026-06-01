/**
 * Precomputed full-universe portfolios.
 *
 * Evaluating ~1,500 companies live is too heavy for a small/free host (and would
 * hammer SEC on every request). Instead we generate the three risk-level
 * portfolios OFFLINE (warm cache) via `npm run precompute`, commit the small JSON
 * results, and serve them instantly. The files live in data/precomputed/ and ARE
 * committed (unlike the raw response cache).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

export const PRECOMPUTED_DIR = path.join(config.paths.data, 'precomputed');

const RISK_LEVELS = ['conservative', 'moderate', 'aggressive'];

function fileFor(riskLevel) {
  return path.join(PRECOMPUTED_DIR, `portfolio_${riskLevel}.json`);
}

/** Load a precomputed portfolio for a risk level, or null if not present. */
export function loadPrecomputedPortfolio(riskLevel) {
  if (!RISK_LEVELS.includes(riskLevel)) return null;
  try {
    const raw = fs.readFileSync(fileFor(riskLevel), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True if a precomputed file exists for this risk level. */
export function hasPrecomputed(riskLevel) {
  try {
    return fs.existsSync(fileFor(riskLevel));
  } catch {
    return false;
  }
}

/** Persist a precomputed portfolio response (used by the precompute script). */
export function savePrecomputedPortfolio(riskLevel, response) {
  fs.mkdirSync(PRECOMPUTED_DIR, { recursive: true });
  fs.writeFileSync(fileFor(riskLevel), JSON.stringify(response, null, 2));
}
