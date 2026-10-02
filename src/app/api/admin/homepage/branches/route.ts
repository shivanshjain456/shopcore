import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { listBranchesForAdmin, upsertBranch } from '@/lib/cms/homepage';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  return jsonOk({ items: await listBranchesForAdmin() });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = await req.json() as Record<string, unknown>;
  const row = await upsertBranch(null, {
    name:        String(body.name ?? ''),
    city:        String(body.city ?? ''),
    address:     (body.address as string | null | undefined) ?? null,
    phone:       (body.phone   as string | null | undefined) ?? null,
    imageUrl:    (body.imageUrl as string | null | undefined) ?? null,
    linkUrl:     (body.linkUrl  as string | null | undefined) ?? null,
    displayOrder:typeof body.displayOrder === 'number' ? body.displayOrder : undefined,
    isActive:    body.isActive === undefined ? undefined : !!body.isActive,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_BRANCH_UPDATE',
    entity: 'HomepageBranch', entityId: row.id, after: row,
  });
  return jsonOk({ branch: row });
});
