/**
 * Disk-backed cache for external API responses.
 *
 * Why: providers rate-limit aggressively and fundamentals change rarely. We key
 * each response to a deterministic filename, store JSON with a timestamp, and
 * serve from disk until the TTL expires. This keeps the app responsive and
 * polite to upstream APIs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from './logger.js';

function keyToFile(namespace, key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const safeNs = namespace.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(config.cache.dir, `${safeNs}__${hash}.json`);
}

async function ensureDir() {
  await fs.mkdir(config.cache.dir, { recursive: true });
}

/**
 * Read a cached value if present and not expired.
 * @returns {Promise<any|null>} the cached payload, or null on miss/expiry
 */
export async function cacheGet(namespace, key, ttlHours = config.cache.ttlHours) {
  try {
    const file = keyToFile(namespace, key);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - parsed.storedAt;
    if (ageMs > ttlHours * 3600 * 1000) {
      logger.debug(`cache expired: ${namespace} (${(ageMs / 3600000).toFixed(1)}h old)`);
      return null;
    }
    logger.debug(`cache hit: ${namespace}`);
    return parsed.payload;
  } catch {
    return null; // miss or unreadable -> treat as miss
  }
}

/**
 * Persist a value to the cache.
 */
export async function cacheSet(namespace, key, payload) {
  try {
    await ensureDir();
    const file = keyToFile(namespace, key);
    const body = JSON.stringify({ namespace, key, storedAt: Date.now(), payload });
    await fs.writeFile(file, body, 'utf8');
  } catch (err) {
    logger.warn(`cache write failed for ${namespace}: ${err.message}`);
  }
}

/**
 * Convenience wrapper: return cached value or run the loader, caching its result.
 * Loader errors are propagated (so callers can decide how to degrade).
 */
export async function cached(namespace, key, ttlHours, loader) {
  const hit = await cacheGet(namespace, key, ttlHours);
  if (hit !== null) return hit;
  const fresh = await loader();
  if (fresh !== null && fresh !== undefined) {
    await cacheSet(namespace, key, fresh);
  }
  return fresh;
}
