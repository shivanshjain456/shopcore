/**
 * GET  /api/admin/store-config — returns the full unified config + every
 *      schema entry (label / description / category / section / type /
 *      default / dangerLevel / requiresRestart / enumOptions) so the
 *      admin UI can render dynamically without a hand-maintained map.
 *
 * PATCH /api/admin/store-config — accepts `{ changes: { 'features.b2bEnabled': false, ... } }`.
 *      Atomic validation (all-or-nothing); writes audit log; invalidates
 *      the in-process cache; syncs `data/maintenance.json` if any
 *      `maintenance.*` key changed; enqueues `affectsJobs` jobs.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { log } from '@/lib/log';
import {
  getStoreConfig, applyConfigPatch,
  CONFIG_SCHEMA, ALL_CONFIG_KEYS,
  type ConfigKey,
} from '@/lib/storeConfig';
import { syncMaintenanceFile } from '@/lib/storeConfig/maintenance';
import { enqueueJob } from '@/lib/jobs/producer';

export const dynamic = 'force-dynamic';

/** Shape of one row in the schema payload returned by GET. The admin
 *  UI uses this to render every field — we never duplicate the metadata
 *  client-side. */
interface SchemaRow {
  key:             string;
  type:            string;
  default:         unknown;
  label:           string;
  description:     string;
  category:        string;
  section:         string;
  dangerLevel:     string | null;
  requiresRestart: boolean;
  enumOptions:     readonly { value: string; label: string }[] | null;
  /** Item 9 — UI renderer hint. `'phone'` swaps the default text input
   *  for `<PhoneField>` (locked +91, digit-only). Other values
   *  reserved (`'email' | 'url' | 'textarea'`). */
  fieldType:       string | null;
}

/** Legacy deep-merge — preserves arrays as replaced (not merged) and
 *  primitives as overwrite. Used only by the legacy nested PATCH path. */
function deepMergeLegacy<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object') return base;
  const out = Array.isArray(base)
    ? [...(base as unknown[])]
    : { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const bv = (out as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
        && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      (out as Record<string, unknown>)[k] = deepMergeLegacy(bv, v);
    } else if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out as T;
}

function buildSchemaPayload(): SchemaRow[] {
  return ALL_CONFIG_KEYS.map((key): SchemaRow => {
    const e = CONFIG_SCHEMA[key];
    return {
      key:             e.key,
      type:            e.type,
      default:         e.default,
      label:           e.label,
      description:     e.description,
      category:        e.category,
      section:         e.section,
      dangerLevel:     e.dangerLevel ?? null,
      requiresRestart: e.requiresRestart ?? false,
      enumOptions:     e.enumOptions ?? null,
      fieldType:       e.fieldType ?? null,
    };
  });
}

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  const config = await getStoreConfig();
  return jsonOk({ config, schema: buildSchemaPayload() });
});

// PATCH body. The NEW shape is `{ changes: { 'features.b2bEnabled': false, ... } }`
// using dot-key paths — this is what the Phase-2 admin UI will send.
// For backwards compatibility we ALSO accept the OLD nested shape
// (`{ store: {...}, policies: {...}, ... }`) used by the existing
// (Phase-1-untouched) admin page — we flatten it and feed it through
// the same validator. Once the Phase-2 UI ships and the old page is
// retired, this branch can be deleted.
const NewBody = z.object({
  changes: z.record(z.string(), z.unknown()).refine(
    (o) => Object.keys(o).length > 0,
    { message: 'At least one change is required.' },
  ),
});

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const rawBody = await req.json() as Record<string, unknown>;

  // Detect shape:
  //   - NEW: `{ changes: { 'features.b2bEnabled': false, ... } }`
  //   - LEGACY (still used by the un-replaced admin UI):
  //     `{ store: {...}, policies: {...}, shipping: {...}, ... }`
  //
  // The legacy path may include keys that aren't in the new schema
  // (e.g. `policies.cancellation.windowHours` — kept in the DB blob
  // unchanged for backwards compat). The NEW path validates strictly.
  const isNewShape =
    rawBody !== null
    && typeof rawBody === 'object'
    && typeof rawBody['changes'] === 'object'
    && rawBody['changes'] !== null;

  if (!isNewShape) {
    // Legacy: deep-merge into the existing DB blob, no schema validation.
    // We still write an audit log + invalidate the cache.
    const { prisma } = await import('@/lib/db/client');
    const { invalidateConfigCache, getStoreConfig } = await import('@/lib/storeConfig');
    const before = await getStoreConfig();
    const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
    let blob: Record<string, unknown> = {};
    if (row) { try { blob = JSON.parse(row.data) as Record<string, unknown>; } catch { blob = {}; } }
    const merged = deepMergeLegacy(blob, rawBody);
    await prisma.storeConfig.upsert({
      where:  { id: 'singleton' },
      update: { data: JSON.stringify(merged) },
      create: { id: 'singleton', data: JSON.stringify(merged) },
    });
    invalidateConfigCache();
    const after = await getStoreConfig();
    await audit({
      actorId:  admin.id,
      action:   'STORE_CONFIG_UPDATED',
      entity:   'StoreConfig',
      entityId: 'singleton',
      before, after,
    });
    log.info('config.updated', { adminId: admin.id, changedKeys: ['<legacy-nested>'], keyCount: 0 });
    return jsonOk({ config: after, changedKeys: [] });
  }

  const changesFlat = NewBody.parse(rawBody).changes;
  const result = await applyConfigPatch(changesFlat);
  if (!result.ok) {
    return jsonError('Config validation failed.', 400, {
      code: 'CONFIG_VALIDATION_ERROR',
      issues: Object.entries(result.errors).map(([key, message]) => ({ path: key, message })),
    });
  }

  const { before, after, changedKeys } = result;

  // ── Audit ── changed keys only, before/after values
  const beforeChanged: Record<string, unknown> = {};
  const afterChanged:  Record<string, unknown> = {};
  for (const key of changedKeys) {
    const [head, ...rest] = key.split('.');
    // Walk into the nested objects to fetch the leaf value for audit.
    const getLeaf = (obj: Record<string, unknown>): unknown => {
      let cursor: unknown = obj[head];
      for (const seg of rest) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = (cursor as Record<string, unknown>)[seg];
      }
      return cursor;
    };
    beforeChanged[key] = getLeaf(before as unknown as Record<string, unknown>);
    afterChanged[key]  = getLeaf(after  as unknown as Record<string, unknown>);
  }

  await audit({
    actorId:  admin.id,
    action:   'STORE_CONFIG_UPDATED',
    entity:   'StoreConfig',
    entityId: 'singleton',
    before:   beforeChanged,
    after:    afterChanged,
  });

  log.info('config.updated', {
    adminId:     admin.id,
    changedKeys,
    keyCount:    changedKeys.length,
  });

  // ── Maintenance file sync ── only if any maintenance.* changed
  const touchedMaintenance = changedKeys.some((k) => k.startsWith('maintenance.'));
  if (touchedMaintenance) {
    try {
      await syncMaintenanceFile(after);
    } catch (e) {
      log.warn('maintenance.file_write_failed', { error: (e as Error).message });
    }
    if (after.maintenance.maintenanceMode && !before.maintenance.maintenanceMode) {
      log.warn('config.maintenance_mode_enabled', {
        adminId:    admin.id,
        allowedIps: after.maintenance.allowedMaintenanceIps,
      });
    } else if (!after.maintenance.maintenanceMode && before.maintenance.maintenanceMode) {
      log.info('config.maintenance_mode_disabled', { adminId: admin.id });
    }
  }

  // ── Job dispatch ── union of affectsJobs from every changed key
  const jobsToEnqueue = new Set<string>();
  for (const key of changedKeys) {
    const entry = CONFIG_SCHEMA[key as ConfigKey];
    if (entry.affectsJobs) {
      for (const j of entry.affectsJobs) jobsToEnqueue.add(j);
    }
  }
  for (const jobType of jobsToEnqueue) {
    try {
      // Empty payload — these handlers all support "scan everything"
      // when called with no scope. We accept the JobType from the
      // schema as a typed string and pass {} as the payload; the
      // worker re-validates payload shape at execution time, so the
      // generic-narrowing dance is unnecessary here.
      type J = Parameters<typeof enqueueJob>[0];
      type P = Parameters<typeof enqueueJob>[1];
      await enqueueJob(jobType as J, {} as P, { priority: 1 });
    } catch (e) {
      log.warn('config.job_enqueue_failed', { jobType, error: (e as Error).message });
    }
  }

  return jsonOk({ config: after, changedKeys });
});
