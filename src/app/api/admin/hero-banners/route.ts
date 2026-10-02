/**
 * Admin hero-banner CRUD list + create — Feature #15.
 *
 *   GET  /api/admin/hero-banners
 *     → { items: HeroBanner[] }  — every row, including drafts + expired
 *
 *   POST /api/admin/hero-banners
 *     body: HeroBannerCreateInput
 *     → { banner: HeroBanner }
 *
 *   All endpoints require an admin session via `requireAdminUser()`.
 *   All mutations CSRF-checked and audit-logged.
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { listAllBanners, createBanner } from '@/lib/cms/heroBanners';
import { HeroBannerCreateSchema } from '@/lib/cms/schemas';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  const items = await listAllBanners();
  return jsonOk({ items });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body  = HeroBannerCreateSchema.parse(await req.json());
  const banner = await createBanner(
    {
      ...body,
      startsAt: body.startsAt instanceof Date ? body.startsAt : (body.startsAt ?? null),
      endsAt:   body.endsAt   instanceof Date ? body.endsAt   : (body.endsAt   ?? null),
    },
    admin.id,
  );
  await audit({
    actorId: admin.id,
    action:  'HERO_BANNER_CREATE',
    entity:  'HeroBanner',
    entityId: banner.id,
    after: banner,
  });
  return jsonOk({ banner });
});
