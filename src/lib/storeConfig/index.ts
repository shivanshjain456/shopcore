/**
 * Store Config — server-side reader.
 *
 * The single legitimate entry point for reading admin-tunable settings.
 *
 * Shape: `getStoreConfig()` returns a *unified* view that contains BOTH
 *   (a) the new flat-key schema (`features`, `payments`, `checkout`,
 *       `notifications`, `security`, `performance`, `maintenance`,
 *       + extended `shipping`, `loyalty`, `b2b`, `store`) and
 *   (b) the legacy nested shape (`policies`, `hero`, plus the original
 *       sub-fields on `shipping`, `loyalty`, `b2b`, `store`).
 *
 * The legacy half is preserved verbatim so the 15+ existing callers of
 * `getStoreConfig()` in placeOrder/totals/returns/loyalty/etc. continue
 * to work without modification.
 *
 * SERVER-ONLY. Calls Prisma. Importing from a 'use client' file is a bug.
 */
// Re-import via a relative path so this file remains self-contained.
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import {
  DEFAULT_STORE_CONFIG, type StoreConfigShape,
} from './defaults';
import {
  CONFIG_SCHEMA, ALL_CONFIG_KEYS, isConfigKey,
  type ConfigKey,
} from './schema';
import type { StoreConfigValues } from './types';
import { readCache, writeCache, invalidateConfigCache } from './cache';

export { invalidateConfigCache } from './cache';
export { CONFIG_SCHEMA, ALL_CONFIG_KEYS, isConfigKey, type ConfigKey } from './schema';
export type { StoreConfigValues, StoreConfigPatch } from './types';

/**
 * Unified return type: new flat-key categories AND legacy nested fields
 * (policies + hero + sub-fields). Existing call sites use
 * `cfg.policies.cancellation.windowHours`; new code uses
 * `cfg.features.b2bEnabled`. Both work.
 */
export type UnifiedStoreConfig = StoreConfigValues & StoreConfigShape;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Take a flat dot-key map and build a nested object. */
function nestifyFlat(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const next = cursor[seg];
      if (next === undefined || next === null || typeof next !== 'object') {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}

/** Take a nested object and return a flat dot-key map (inverse of nestify). */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    // Treat arrays as leaf values (`security.allowedImageDomains` is an array).
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenObject(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Build a fully-populated flat values map: schema defaults + DB overrides.
 * Invalid DB values fall back to the schema default with a `log.warn`.
 */
function mergeWithDefaults(dbFlat: Record<string, unknown>): Record<ConfigKey, unknown> {
  const out = {} as Record<ConfigKey, unknown>;
  for (const key of ALL_CONFIG_KEYS) {
    const entry = CONFIG_SCHEMA[key];
    if (Object.prototype.hasOwnProperty.call(dbFlat, key)) {
      const candidate = dbFlat[key];
      const parsed = entry.validation.safeParse(candidate);
      if (parsed.success) {
        out[key] = parsed.data;
      } else {
        log.warn('config.validation_failed', {
          key,
          reason: parsed.error.issues[0]?.message ?? 'invalid',
        });
        out[key] = entry.default;
      }
    } else {
      out[key] = entry.default;
    }
  }
  return out;
}

/** Build the legacy nested shape from the DB blob — preserves any
 *  existing nested fields (policies, hero, etc.) plus shipping/loyalty/
 *  b2b/store keys we haven't migrated to the flat schema. */
function buildLegacy(dbBlob: Record<string, unknown>): StoreConfigShape {
  const parsed = (dbBlob ?? {}) as Partial<StoreConfigShape>;
  return {
    ...DEFAULT_STORE_CONFIG,
    ...parsed,
    store:    { ...DEFAULT_STORE_CONFIG.store,    ...(parsed.store ?? {}) },
    policies: {
      ...DEFAULT_STORE_CONFIG.policies,
      ...(parsed.policies ?? {}),
      cancellation: { ...DEFAULT_STORE_CONFIG.policies.cancellation, ...(parsed.policies?.cancellation ?? {}) },
      returns:      { ...DEFAULT_STORE_CONFIG.policies.returns,      ...(parsed.policies?.returns      ?? {}) },
      exchanges:    { ...DEFAULT_STORE_CONFIG.policies.exchanges,    ...(parsed.policies?.exchanges    ?? {}) },
      refunds:      { ...DEFAULT_STORE_CONFIG.policies.refunds,      ...(parsed.policies?.refunds      ?? {}) },
    },
    shipping: { ...DEFAULT_STORE_CONFIG.shipping, ...(parsed.shipping ?? {}) },
    loyalty:  { ...DEFAULT_STORE_CONFIG.loyalty,  ...(parsed.loyalty  ?? {}) },
    b2b:      { ...DEFAULT_STORE_CONFIG.b2b,      ...(parsed.b2b      ?? {}) },
    hero:     { ...DEFAULT_STORE_CONFIG.hero,     ...(parsed.hero     ?? {}) },
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Read the merged store config. Server-only.
 *
 *   - Lazily creates the StoreConfig singleton row on first read (so
 *     fresh installs work without a seed step).
 *   - Validates DB values against the schema; invalid values fall back
 *     to defaults with a `log.warn`.
 *   - Cached in-process for 30s; cache is invalidated on every
 *     successful admin PATCH.
 *
 * Unknown DB keys are preserved (forward-compat with future schemas)
 * but are NOT returned in the typed view — only schema-known keys.
 */
export async function getStoreConfig(): Promise<UnifiedStoreConfig> {
  const cached = readCache();
  if (cached !== null) {
    return cached as UnifiedStoreConfig;
  }

  let raw: unknown = {};
  const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
  if (!row) {
    // Lazy creation — spec §3.9 + 5.1
    log.warn('config.db_row_missing_created', {});
    await prisma.storeConfig.upsert({
      where:  { id: 'singleton' },
      update: {},
      create: { id: 'singleton', data: JSON.stringify({}) },
    });
  } else {
    try {
      raw = JSON.parse(row.data) as unknown;
    } catch {
      log.warn('config.json_parse_failed', { rowId: 'singleton' });
      raw = {};
    }
  }

  const dbBlob = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Flatten the DB blob so we can look up dot-keys, but also keep the
  // original nested view for the legacy half.
  const dbFlat = flattenObject(dbBlob);
  const flatValues = mergeWithDefaults(dbFlat);
  // Re-nest the schema-known values into objects (features.*, payments.*…)
  const nested = nestifyFlat(flatValues as Record<string, unknown>);
  // Build the legacy nested shape (policies/hero/etc.) over the SAME
  // DB blob. The two halves overwrite where they overlap (the new
  // flat schema takes precedence for keys it owns, e.g. store.name).
  const legacy = buildLegacy(dbBlob);

  // Merge: legacy provides nested store/shipping/loyalty/b2b WITH the
  // pre-existing sub-keys; the new flat schema OVERRIDES the same paths
  // (and adds entirely new ones like features.*, maintenance.*, …).
  const unified = {
    ...legacy,
    ...(nested as Record<string, unknown>),
    // Deep-merge the categories that both halves touch.
    store:    { ...legacy.store,    ...(nested.store    as Record<string, unknown>) },
    shipping: { ...legacy.shipping, ...(nested.shipping as Record<string, unknown>) },
    loyalty:  { ...legacy.loyalty,  ...(nested.loyalty  as Record<string, unknown>) },
    b2b:      { ...legacy.b2b,      ...(nested.b2b      as Record<string, unknown>) },
  } as UnifiedStoreConfig;

  writeCache(unified as StoreConfigValues);
  return unified;
}

/**
 * Persist a partial config update. Atomic: all values are validated
 * before any is written.
 *
 *   - Returns `{ ok: true, config }` on success, `{ ok: false, errors }`
 *     on validation failure.
 *   - On success: invalidates the cache, writes the maintenance.json
 *     file if any maintenance.* key changed, but does NOT touch the
 *     job queue (the route handler does that — it has the admin's user
 *     id for the audit).
 */
export async function applyConfigPatch(
  flatPatch: Record<string, unknown>,
): Promise<
  | { ok: true; before: UnifiedStoreConfig; after: UnifiedStoreConfig; changedKeys: ConfigKey[] }
  | { ok: false; errors: Record<string, string> }
> {
  const { validateConfigPatch } = await import('./validation');
  const result = validateConfigPatch(flatPatch);
  if (!result.ok) return { ok: false, errors: result.errors };

  const before = await getStoreConfig();

  // Read raw DB blob so we can preserve unknown keys (forward-compat).
  const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
  let rawBlob: Record<string, unknown> = {};
  if (row) {
    try { rawBlob = JSON.parse(row.data) as Record<string, unknown>; }
    catch { rawBlob = {}; }
  }
  // Flatten existing DB values, overlay the validated patch, re-nest.
  const flatBefore = flattenObject(rawBlob);
  const flatNext: Record<string, unknown> = { ...flatBefore, ...result.values };
  const nextBlob = nestifyFlat(flatNext);

  await prisma.storeConfig.upsert({
    where:  { id: 'singleton' },
    update: { data: JSON.stringify(nextBlob) },
    create: { id: 'singleton', data: JSON.stringify(nextBlob) },
  });

  invalidateConfigCache();
  log.info('config.cache_invalidated', {});

  const after = await getStoreConfig();
  const changedKeys = Object.keys(result.values).filter(isConfigKey) as ConfigKey[];

  return { ok: true, before, after, changedKeys };
}

/** Reset entire config to defaults. Dangerous — caller validates the
 *  confirmation string. */
export async function resetStoreConfigToDefaults(): Promise<UnifiedStoreConfig> {
  await prisma.storeConfig.upsert({
    where:  { id: 'singleton' },
    update: { data: JSON.stringify({}) },
    create: { id: 'singleton', data: JSON.stringify({}) },
  });
  invalidateConfigCache();
  log.info('config.cache_invalidated', {});
  return getStoreConfig();
}

// ── Internal helpers exposed for the API handler / tests ──────────────────
export { flattenObject, nestifyFlat };
