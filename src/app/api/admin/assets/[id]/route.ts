/**
 * DELETE /api/admin/assets/[id] — Item 17 Phase 2.
 *
 *   Removes a StoreAsset (DB row + disk file).
 *
 *   By default the route REFUSES to delete an asset that is still
 *   referenced by a Brand, Category, or store-config key — the admin
 *   must null out those references first (or pass `?force=1` to
 *   override, which is audited).
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { findAssetReferences, deleteAsset } from '@/lib/assets/storeAsset';

export const dynamic = 'force-dynamic';

export const DELETE = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const row = await prisma.storeAsset.findUnique({ where: { id: params.id } });
  if (!row) return jsonError('Asset not found.', 404, { code: 'NOT_FOUND' });

  const refs   = await findAssetReferences(row.url);
  const force  = req.nextUrl.searchParams.get('force') === '1';

  if (refs.length > 0 && !force) {
    // Block — surface every reference so the admin can clean them up.
    return jsonError(
      'Asset is still referenced. Remove every reference first, or retry with ?force=1.',
      409,
      { code: 'ASSET_IN_USE', references: refs },
    );
  }

  const result = await deleteAsset(params.id);
  await audit({
    actorId: admin.id,
    action:  'ASSET_DELETED',
    entity:  'StoreAsset',
    entityId: row.id,
    before:  { url: row.url, kind: row.kind, references: refs },
    after:   { fileGone: result.fileGone, forced: force },
  });
  return jsonOk({ ok: true, fileGone: result.fileGone, forced: force, references: refs });
});
