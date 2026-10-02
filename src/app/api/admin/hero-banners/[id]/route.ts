/**
 * Admin hero-banner single-row routes — Feature #15.
 *
 *   GET    /api/admin/hero-banners/[id]   → { banner }
 *   PATCH  /api/admin/hero-banners/[id]   body: HeroBannerUpdateInput → { banner }
 *   DELETE /api/admin/hero-banners/[id]                                → { deleted: true }
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { getBannerById, updateBanner, deleteBanner } from '@/lib/cms/heroBanners';
import { HeroBannerUpdateSchema } from '@/lib/cms/schemas';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_req: NextRequest, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const banner = await getBannerById(params.id);
  if (!banner) return jsonError('Not found.', 404);
  return jsonOk({ banner });
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await getBannerById(params.id);
  if (!before) return jsonError('Not found.', 404);
  const input = HeroBannerUpdateSchema.parse(await req.json());
  const banner = await updateBanner(
    params.id,
    {
      ...input,
      startsAt: input.startsAt instanceof Date ? input.startsAt : input.startsAt,
      endsAt:   input.endsAt   instanceof Date ? input.endsAt   : input.endsAt,
    },
    admin.id,
  );
  await audit({
    actorId: admin.id,
    action:  'HERO_BANNER_UPDATE',
    entity:  'HeroBanner',
    entityId: banner.id,
    before, after: banner,
  });
  return jsonOk({ banner });
});

export const DELETE = withErrorHandling(async (_req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await getBannerById(params.id);
  if (!before) return jsonError('Not found.', 404);
  await deleteBanner(params.id);
  await audit({
    actorId: admin.id,
    action:  'HERO_BANNER_DELETE',
    entity:  'HeroBanner',
    entityId: params.id,
    before,
  });
  return jsonOk({ deleted: true });
});
