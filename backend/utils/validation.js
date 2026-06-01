/**
 * Input validation and defensive helpers.
 */

/**
 * Validate and normalize a stock ticker. Tickers are 1-6 chars, letters,
 * optionally with a single dot or hyphen for share classes (e.g. BRK.B, RDS-A).
 * @returns {string|null} normalized uppercase ticker, or null if invalid
 */
export function normalizeTicker(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  if (!/^[A-Z]{1,6}([.\-][A-Z]{1,3})?$/.test(t)) return null;
  return t;
}

/**
 * Parse a free-form list of tickers (comma/space/newline separated) into a
 * deduplicated array of valid, normalized tickers plus a list of rejects.
 */
export function parseTickerList(raw, max = 25) {
  if (typeof raw !== 'string') return { valid: [], invalid: [] };
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const tok of tokens) {
    const norm = normalizeTicker(tok);
    if (!norm) {
      invalid.push(tok);
    } else if (!seen.has(norm)) {
      seen.add(norm);
      valid.push(norm);
    }
    if (valid.length >= max) break;
  }
  return { valid, invalid };
}

/** Clamp a number into [min, max], returning fallback for non-finite input. */
export function clamp(n, min, max, fallback = min) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** True if value is a finite, usable number. */
export function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}
