/**
 * GET /api/admin/assets — Item 17 Phase 2.
 *
 *   Returns the paginated StoreAsset registry + coverage stats for
 *   the admin /admin/assets dashboard. Combined response so the
 *   page renders in one round-trip.
 *
 *   Query:
 *     ?kind=<AdminImageKind|'all'>   (default 'all')
 *     ?page=&pageSize=                (canonical pagination, default 20)
 *     ?include=health                 (when present, the response also
 *                                       carries `storeIdentity`, `brands`,
 *                                       `categories` coverage objects)
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';
import { listAssets } from '@/lib/assets/storeAsset';
import { isAdminImageKind } from '@/lib/uploads/imageKinds';
import {
  getStoreIdentityHealth, getBrandHealth, getCategoryHealth,
} from '@/lib/assets/assetHealth';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const config = await getStoreConfig();
  const sp = req.nextUrl.searchParams;
  const kindRaw = sp.get('kind');
  const kind = kindRaw === null || kindRaw === 'all'
    ? 'all' as const
    : (isAdminImageKind(kindRaw) ? kindRaw : 'all' as const);

  const { page, pageSize } = parsePaginationParams(sp, config, { defaultPageSize: 20 });
  const list = await listAssets({ kind, page, pageSize });
  const envelope = buildPagination(list.items, list.total, page, pageSize);

  const data: Record<string, unknown> = { ...envelope, kind };

  if (sp.get('include') === 'health') {
    const [storeIdentity, brands, categories] = await Promise.all([
      getStoreIdentityHealth(),
      getBrandHealth(),
      getCategoryHealth(),
    ]);
    data.health = { storeIdentity, brands, categories };
  }

  return jsonOk(data);
});
