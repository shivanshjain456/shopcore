import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { upsertBranch, deleteBranch } from '@/lib/cms/homepage';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const PATCH = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageBranch.findUnique({ where: { id: params.id } });
  const body = await req.json() as Record<string, unknown>;
  const row = await upsertBranch(params.id, {
    name:        String(body.name ?? before?.name ?? ''),
    city:        String(body.city ?? before?.city ?? ''),
    address:     (body.address as string | null | undefined) ?? before?.address ?? null,
    phone:       (body.phone   as string | null | undefined) ?? before?.phone   ?? null,
    imageUrl:    (body.imageUrl as string | null | undefined) ?? before?.imageUrl ?? null,
    linkUrl:     (body.linkUrl  as string | null | undefined) ?? before?.linkUrl  ?? null,
    displayOrder:typeof body.displayOrder === 'number' ? body.displayOrder : before?.displayOrder ?? 999,
    isActive:    body.isActive === undefined ? before?.isActive ?? true : !!body.isActive,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_BRANCH_UPDATE',
    entity: 'HomepageBranch', entityId: row.id,
    before: before ?? undefined, after: row,
  });
  return jsonOk({ branch: row });
});

export const DELETE = withErrorHandling(async (
  _req: Request,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const before = await prisma.homepageBranch.findUnique({ where: { id: params.id } });
  await deleteBranch(params.id);
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_BRANCH_UPDATE',
    entity: 'HomepageBranch', entityId: params.id,
    before: before ?? undefined, after: { deleted: true },
  });
  return jsonOk({ ok: true });
});
