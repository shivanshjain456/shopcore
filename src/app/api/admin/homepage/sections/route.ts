/**
 * GET  /api/admin/homepage/sections — list all (incl. inactive + future).
 * POST /api/admin/homepage/sections — create a new section.
 *
 *   Item 18 Phase 1. Admin-only. CSRF + audit + rate-limit
 *   (admin.uploads' generic 40/10min policy is reused since this is
 *   an admin write — homepage is low-traffic by nature).
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { listSectionsForAdmin, createSection } from '@/lib/cms/homepage';
import { HOMEPAGE_SECTION_KINDS } from '@/lib/cms/homepageSchemas';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  const sections = await listSectionsForAdmin();
  // Also surface the catalogue of available kinds so the admin UI
  // can build a "+ Add section" dropdown without hard-coding them.
  return jsonOk({ items: sections, availableKinds: HOMEPAGE_SECTION_KINDS });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = await req.json() as Record<string, unknown>;
  const row = await createSection({
    kind:         String(body.kind ?? ''),
    slug:         String(body.slug ?? ''),
    title:        body.title === null ? null : (body.title as string | undefined),
    displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : undefined,
    isActive:     body.isActive === undefined ? undefined : !!body.isActive,
    startsAt:     body.startsAt as string | null | undefined,
    endsAt:       body.endsAt   as string | null | undefined,
    config:       body.config,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_SECTION_CREATE',
    entity: 'HomepageSection', entityId: row.id, after: row,
  });
  return jsonOk({ section: row });
});
