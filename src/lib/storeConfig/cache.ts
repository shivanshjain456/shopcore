/**
 * In-process cache for `getStoreConfig()`. Spec §2.3.
 *
 * Behaviour:
 *   - Stores `{ value, expiresAt }`. Expiry is wall-clock — a stale value
 *     is recomputed on the next call.
 *   - TTL default 30s — a deliberately short window so admin saves
 *     become visible within seconds even on a busy worker, while still
 *     dropping ~99% of read load off the DB.
 *   - `invalidate()` is called by the PATCH handler on every successful
 *     save so admins see their own change immediately.
 *
 * NOT for client components. Module is server-only — importing it from
 * a 'use client' file will throw at build time because it transitively
 * imports Prisma via the consumer in index.ts.
 */
import type { StoreConfigValues } from './types';

const DEFAULT_TTL_MS = 30 * 1000;

interface CacheEntry {
  value:     StoreConfigValues;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;

export function readCache(): StoreConfigValues | null {
  if (_cache === null) return null;
  if (Date.now() >= _cache.expiresAt) {
    _cache = null;
    return null;
  }
  return _cache.value;
}

export function writeCache(value: StoreConfigValues, ttlMs: number = DEFAULT_TTL_MS): void {
  _cache = { value, expiresAt: Date.now() + ttlMs };
}

/**
 * Invalidate the cached config. Called from the PATCH handler.
 * Safe to call when cache is empty.
 */
export function invalidateConfigCache(): void {
  _cache = null;
}

/** Test escape hatch — never call from production code. */
export function _resetConfigCacheForTests(): void {
  _cache = null;
}
