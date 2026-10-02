/** GET/POST /api/addresses */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { ZIndianState } from '@/lib/enums';
// Item 9: use the canonical phoneSchema (normalises permissive input to E.164).
import { phoneSchema } from '@/lib/auth/schemas';

export const dynamic = 'force-dynamic';

const Body = z.object({
  label:        z.string().trim().max(40).optional(),
  fullName:     z.string().trim().min(1).max(80),
  phone:        phoneSchema,
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().min(1).max(200),
  city:         z.string().trim().min(1).max(80),
  state:        ZIndianState,
  pinCode:      z.string().trim().regex(/^\d{6}$/, '6-digit PIN required.'),
  country:      z.literal('India'),
});

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  // PAGINATION-EXEMPT: scoped to one user; addresses are capped at the per-user limit.
  const addresses = await prisma.address.findMany({
    where: { userId: user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  return jsonOk({ addresses });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const data = Body.parse(await req.json());
  const count = await prisma.address.count({ where: { userId: user.id } });
  const address = await prisma.address.create({
    data: { ...data, userId: user.id, isDefault: count === 0 },
  });
  return jsonOk({ address });
});
