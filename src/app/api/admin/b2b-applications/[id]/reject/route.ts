import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().trim().max(300).optional() });

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { reason } = Body.parse(await req.json().catch(() => ({})));
  const user = await prisma.user.findUnique({ where: { id: params.id } });
  if (!user) return jsonError('User not found.', 404);
  if (!user.companyName || !user.gstin) return jsonError('No application on file.', 400);
  if (user.role === 'B2B' && user.b2bApprovedAt) return jsonError('Cannot reject an already-approved B2B user; demote instead.', 400);

  const before = { companyName: user.companyName, gstin: user.gstin, pan: user.pan };
  await prisma.user.update({
    where: { id: user.id },
    data: { companyName: null, gstin: null, pan: null },
  });
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'B2B_REJECTED', metadata: JSON.stringify({ reason: reason ?? null }) },
  });
  await audit({
    actorId: admin.id, action: 'B2B_REJECT', entity: 'User', entityId: user.id,
    before, after: { companyName: null, gstin: null, pan: null, reason: reason ?? null },
  });
  return jsonOk({ rejected: true });
});
