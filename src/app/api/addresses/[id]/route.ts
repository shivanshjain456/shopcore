import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { ZIndianState } from '@/lib/enums';
// Item 9: canonical phoneSchema — normalises permissive input to E.164.
import { phoneSchema } from '@/lib/auth/schemas';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  label:        z.string().trim().max(40).nullable().optional(),
  fullName:     z.string().trim().min(1).max(80).optional(),
  phone:        phoneSchema.optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().min(1).max(200).optional(),
  city:         z.string().trim().min(1).max(80).optional(),
  state:        ZIndianState.optional(),
  pinCode:      z.string().trim().regex(/^\d{6}$/).optional(),
  isDefault:    z.boolean().optional(),
});

async function loadOwn(userId: string, id: string) {
  const a = await prisma.address.findUnique({ where: { id } });
  if (!a || a.userId !== userId) return null;
  return a;
}

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const a = await loadOwn(user.id, params.id);
  if (!a) return jsonError('Address not found.', 404);
  const data = PatchBody.parse(await req.json());
  // If setting isDefault=true, unset all others first
  if (data.isDefault) {
    await prisma.address.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
  }
  const updated = await prisma.address.update({ where: { id: a.id }, data });
  return jsonOk({ address: updated });
});

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const a = await loadOwn(user.id, params.id);
  if (!a) return jsonError('Address not found.', 404);
  // Prevent delete if referenced by an order
  const inUse = await prisma.order.count({ where: { OR: [{ shippingAddressId: a.id }, { billingAddressId: a.id }] } });
  if (inUse > 0) return jsonError('Cannot delete an address used in past orders.', 400);
  await prisma.address.delete({ where: { id: a.id } });
  return jsonOk({ deleted: true });
});
