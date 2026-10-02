import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({ isApproved: z.boolean() });

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { isApproved } = PatchBody.parse(await req.json());
  const existing = await prisma.review.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  const updated = await prisma.review.update({ where: { id: existing.id }, data: { isApproved } });
  await audit({ actorId: admin.id, action: 'REVIEW_MODERATE', entity: 'Review', entityId: existing.id, before: existing, after: updated });
  return jsonOk({ review: updated });
});

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const existing = await prisma.review.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  await prisma.review.delete({ where: { id: existing.id } });
  await audit({ actorId: admin.id, action: 'REVIEW_DELETE', entity: 'Review', entityId: existing.id, before: existing });
  return jsonOk({ deleted: true });
});
