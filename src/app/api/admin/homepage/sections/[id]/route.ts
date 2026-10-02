/**
 * PATCH /api/admin/homepage/sections/[id]  — update a section.
 * DELETE /api/admin/homepage/sections/[id] — delete a section.
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { updateSection, deleteSection } from '@/lib/cms/homepage';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const PATCH = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageSection.findUnique({ where: { id: params.id } });
  const body = await req.json() as Record<string, unknown>;
  const row = await updateSection(params.id, {
    title:        body.title === null ? null : (body.title as string | undefined),
    displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : undefined,
    isActive:     body.isActive === undefined ? undefined : !!body.isActive,
    startsAt:     body.startsAt as string | null | undefined,
    endsAt:       body.endsAt   as string | null | undefined,
    config:       body.config,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_SECTION_UPDATE',
    entity: 'HomepageSection', entityId: row.id,
    before: before ?? undefined, after: row,
  });
  return jsonOk({ section: row });
});

export const DELETE = withErrorHandling(async (
  _req: Request,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageSection.findUnique({ where: { id: params.id } });
  await deleteSection(params.id);
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_SECTION_DELETE',
    entity: 'HomepageSection', entityId: params.id,
    before: before ?? undefined,
  });
  return jsonOk({ ok: true });
});
