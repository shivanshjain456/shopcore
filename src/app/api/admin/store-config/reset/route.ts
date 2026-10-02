/**
 * POST /api/admin/store-config/reset
 *
 * Reset the entire StoreConfig blob to schema defaults. Spec §2.7.
 *
 * Hard-coded confirmation guard: body must contain `confirm:
 * 'RESET_ALL_CONFIG'`. Anything else returns 400 — protects against
 * accidental clicks / replays / fat-fingered scripts.
 *
 * Audit captures the FULL before state so an admin can undo by re-importing
 * yesterday's export.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { log } from '@/lib/log';
import { getStoreConfig, resetStoreConfigToDefaults } from '@/lib/storeConfig';
import { syncMaintenanceFile } from '@/lib/storeConfig/maintenance';

export const dynamic = 'force-dynamic';

const Body = z.object({
  confirm: z.literal('RESET_ALL_CONFIG'),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  // Throws ValidationError → 400 if confirm string is wrong.
  Body.parse(await req.json());

  const before = await getStoreConfig();
  const after  = await resetStoreConfigToDefaults();

  await audit({
    actorId:  admin.id,
    action:   'STORE_CONFIG_RESET',
    entity:   'StoreConfig',
    entityId: 'singleton',
    before,
    after,
  });
  log.info('config.reset', { adminId: admin.id });

  // Force maintenance file back to defaults (off) so a previous true
  // doesn't leak past the reset.
  try { await syncMaintenanceFile(after); }
  catch (e) { log.warn('maintenance.file_write_failed', { error: (e as Error).message }); }

  // Belt: signal misuse with a 400 — but we already threw via z.literal.
  void jsonError;

  return jsonOk({ config: after });
});
