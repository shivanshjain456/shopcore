/**
 * PATCH/DELETE /api/admin/homepage/metrics/[id].
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { upsertMetric, deleteMetric } from '@/lib/cms/homepage';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const PATCH = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageMetric.findUnique({ where: { id: params.id } });
  const body = await req.json() as Record<string, unknown>;
  const row = await upsertMetric(params.id, {
    label:        String(body.label ?? before?.label ?? ''),
    value:        String(body.value ?? before?.value ?? ''),
    caption:      (body.caption as string | null | undefined) ?? before?.caption ?? null,
    iconUrl:      (body.iconUrl as string | null | undefined) ?? before?.iconUrl ?? null,
    displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : before?.displayOrder ?? 999,
    isActive:     body.isActive === undefined ? before?.isActive ?? true : !!body.isActive,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_METRIC_UPDATE',
    entity: 'HomepageMetric', entityId: row.id,
    before: before ?? undefined, after: row,
  });
  return jsonOk({ metric: row });
});

export const DELETE = withErrorHandling(async (
  _req: Request,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageMetric.findUnique({ where: { id: params.id } });
  await deleteMetric(params.id);
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_METRIC_UPDATE',
    entity: 'HomepageMetric', entityId: params.id,
    before: before ?? undefined, after: { deleted: true },
  });
  return jsonOk({ ok: true });
});
