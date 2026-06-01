/**
 * Thin fetch wrapper with timeout, retry-with-backoff, and rate-limit awareness.
 * Centralizes outbound HTTP so every provider gets consistent resilience.
 */
import { logger } from '../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-host minimum spacing between requests (ms). SEC EDGAR enforces a ~10 req/s
 * fair-access limit; we throttle to ~8/s so large-universe screens never trigger
 * a 429 backoff storm (which, counter-intuitively, is FASTER than bursting). The
 * limiter serializes the "gate" only — actual responses still arrive in parallel.
 */
const HOST_MIN_INTERVAL_MS = {
  'data.sec.gov': 150,
  'www.sec.gov': 150,
};
const hostNextFree = new Map();

/** Resolve when it's this host's turn, honoring its minimum spacing. */
async function rateLimitGate(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const interval = HOST_MIN_INTERVAL_MS[host];
  if (!interval) return;
  const now = Date.now();
  const earliest = Math.max(now, hostNextFree.get(host) || 0);
  hostNextFree.set(host, earliest + interval);
  const wait = earliest - now;
  if (wait > 0) await sleep(wait);
}

/**
 * GET JSON with retries. Honors HTTP 429 (rate limit) and 5xx with exponential
 * backoff. Throws a descriptive Error on final failure so callers can degrade.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {Object} [opts.headers]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.retries=5]
 */
export async function getJson(url, { headers = {}, timeoutMs = 15000, retries = 5 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    await rateLimitGate(url); // stay under per-host rate limits

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        // Rate limited or upstream error — back off (capped) and retry. A longer
        // cap lets a name ride out a temporary SEC penalty instead of being
        // dropped from a large-universe screen.
        const waitMs = Math.min(2 ** attempt * 1000, 20000);
        logger.warn(`HTTP ${res.status} from ${hostOf(url)} — backing off ${waitMs}ms (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(waitMs);
        attempt += 1;
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} from ${hostOf(url)}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === 'AbortError') {
        logger.warn(`Timeout after ${timeoutMs}ms: ${hostOf(url)}`);
      }
      const waitMs = Math.min(2 ** attempt * 1000, 20000);
      if (attempt < retries) await sleep(waitMs);
      attempt += 1;
    }
  }
  throw new Error(`Request failed after ${retries + 1} attempts: ${lastErr?.message || 'unknown'}`);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
