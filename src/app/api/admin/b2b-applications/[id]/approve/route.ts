import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const Body = z.object({ tierId: z.string().min(1) });

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { tierId } = Body.parse(await req.json());
  const user = await prisma.user.findUnique({ where: { id: params.id } });
  if (!user) return jsonError('User not found.', 404);
  if (!user.companyName || !user.gstin) return jsonError('This user has no B2B application on file.', 400);
  if (user.role === 'B2B' && user.b2bApprovedAt) return jsonError('Already approved.', 400);
  const tier = await prisma.b2BTier.findUnique({ where: { id: tierId } });
  if (!tier) return jsonError('Tier not found.', 400);

  const before = { role: user.role, b2bApprovedAt: user.b2bApprovedAt, b2bTierId: user.b2bTierId };
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: 'B2B', b2bApprovedAt: new Date(), b2bTierId: tier.id },
  });
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'B2B_APPROVED', metadata: JSON.stringify({ tierId: tier.id }) },
  });
  await audit({
    actorId: admin.id, action: 'B2B_APPROVE', entity: 'User', entityId: user.id,
    before, after: { role: updated.role, b2bApprovedAt: updated.b2bApprovedAt, b2bTierId: updated.b2bTierId },
  });

  return jsonOk({ approved: true });
});
