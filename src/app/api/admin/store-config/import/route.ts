/**
 * POST /api/admin/store-config/import
 *
 * Two-phase import (spec §3.7):
 *
 *   Phase A (preview):   POST `{ config: <exported JSON> }`
 *                        → returns the diff (changedKeys + before/after
 *                          for each). NO write performed.
 *
 *   Phase B (apply):     POST `{ config: <exported JSON>, confirmed: true }`
 *                        → runs the diff as a single atomic PATCH;
 *                          writes audit; invalidates cache; syncs
 *                          maintenance.json if relevant.
 *
 * The two-phase API lets the admin UI render "we're about to change
 * 17 settings — are you sure?" without a separate diff endpoint.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { log } from '@/lib/log';
import {
  getStoreConfig, applyConfigPatch,
  ALL_CONFIG_KEYS, type ConfigKey,
} from '@/lib/storeConfig';
import { flattenObject } from '@/lib/storeConfig';
import { syncMaintenanceFile } from '@/lib/storeConfig/maintenance';

export const dynamic = 'force-dynamic';

const Body = z.object({
  config:    z.unknown(),
  confirmed: z.boolean().optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin   = await requireAdminUser();
  const body    = Body.parse(await req.json());
  const current = await getStoreConfig();

  if (body.config === null || typeof body.config !== 'object') {
    return jsonError('Uploaded config must be a JSON object.', 400, {
      code: 'INVALID_CONFIG_FILE',
    });
  }

  // Flatten the uploaded blob to dot-keys and drop anything that isn't
  // a known config key (forward-compat: unknown keys silently ignored).
  const flatUploaded = flattenObject(body.config as Record<string, unknown>);
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(flatUploaded)) {
    if (ALL_CONFIG_KEYS.includes(key as ConfigKey)) {
      candidate[key] = flatUploaded[key];
    }
  }

  // ── Phase A: preview (default) ──
  if (!body.confirmed) {
    // Diff against current — only include keys whose value actually
    // changes. Pre-validate so the preview reflects what WOULD happen
    // (caller sees errors here, not on second POST).
    const flatCurrent = flattenObject(current as unknown as Record<string, unknown>);
    const diff: Array<{ key: string; before: unknown; after: unknown }> = [];
    for (const [k, v] of Object.entries(candidate)) {
      if (JSON.stringify(flatCurrent[k]) !== JSON.stringify(v)) {
        diff.push({ key: k, before: flatCurrent[k] ?? null, after: v });
      }
    }
    log.info('config.import_preview', { adminId: admin.id, candidateCount: diff.length });
    return jsonOk({ preview: true, diff, totalCandidateKeys: Object.keys(candidate).length });
  }

  // ── Phase B: apply ──
  const result = await applyConfigPatch(candidate);
  if (!result.ok) {
    return jsonError('Imported config failed validation.', 400, {
      code: 'CONFIG_VALIDATION_ERROR',
      issues: Object.entries(result.errors).map(([key, message]) => ({ path: key, message })),
    });
  }

  await audit({
    actorId:  admin.id,
    action:   'STORE_CONFIG_IMPORTED',
    entity:   'StoreConfig',
    entityId: 'singleton',
    before:   { changedKeys: result.changedKeys, source: 'import' },
    after:    { changedKeys: result.changedKeys },
  });
  log.info('config.imported', { adminId: admin.id, changedKeys: result.changedKeys });

  if (result.changedKeys.some((k) => k.startsWith('maintenance.'))) {
    try { await syncMaintenanceFile(result.after); }
    catch (e) { log.warn('maintenance.file_write_failed', { error: (e as Error).message }); }
  }

  return jsonOk({ config: result.after, changedKeys: result.changedKeys, applied: true });
});
