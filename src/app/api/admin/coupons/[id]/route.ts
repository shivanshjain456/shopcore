import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  isActive: z.boolean().optional(),
  description: z.string().trim().max(200).nullable().optional(),
  validUntil: z.string().optional(),
}).strict();

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = PatchBody.parse(await req.json());
  const existing = await prisma.coupon.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  const data: Record<string, unknown> = { ...body };
  if (body.validUntil) data.validUntil = new Date(body.validUntil);
  const updated = await prisma.coupon.update({ where: { id: existing.id }, data });
  await audit({ actorId: admin.id, action: 'COUPON_UPDATE', entity: 'Coupon', entityId: existing.id, before: existing, after: updated });
  return jsonOk({ coupon: updated });
});

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const existing = await prisma.coupon.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  // If used, soft-deactivate
  if (existing.usedCount > 0) {
    const upd = await prisma.coupon.update({ where: { id: existing.id }, data: { isActive: false } });
    await audit({ actorId: admin.id, action: 'COUPON_DEACTIVATE', entity: 'Coupon', entityId: existing.id, before: existing, after: upd });
    return jsonOk({ deactivated: true });
  }
  await prisma.coupon.delete({ where: { id: existing.id } });
  await audit({ actorId: admin.id, action: 'COUPON_DELETE', entity: 'Coupon', entityId: existing.id, before: existing });
  return jsonOk({ deleted: true });
});
