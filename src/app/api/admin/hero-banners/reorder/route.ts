/**
 * POST /api/admin/hero-banners/reorder — Feature #15.
 *
 *   Bulk-rewrites `displayOrder` so admins can drag-and-drop without
 *   firing N separate PATCHes. The body is a single array of ids in the
 *   new desired order:
 *
 *     { ids: ['b3', 'b1', 'b2'] }   → b3 becomes 0, b1 → 1, b2 → 2
 *
 *   Runs as a single Prisma transaction.
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { reorderBanners } from '@/lib/cms/heroBanners';
import { HeroBannerReorderSchema } from '@/lib/cms/schemas';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { ids } = HeroBannerReorderSchema.parse(await req.json());
  const n = await reorderBanners(ids);
  await audit({
    actorId: admin.id,
    action:  'HERO_BANNER_REORDER',
    entity:  'HeroBanner',
    entityId: 'bulk',
    after: { ids },
  });
  return jsonOk({ count: n });
});
