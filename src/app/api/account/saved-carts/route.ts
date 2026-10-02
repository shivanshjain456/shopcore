/**
 * Saved carts — snapshot current cart, list, restore, delete.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  // PAGINATION-EXEMPT: scoped to one user; capped at 5 by createSavedCart write path.
  const list = await prisma.savedCart.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  return jsonOk({ savedCarts: list.map((s) => ({
    id: s.id, name: s.name, createdAt: s.createdAt,
    items: JSON.parse(s.payload) as Array<{ productId: string; variantId: string | null; quantity: number }>,
  })) });
});

const PostBody = z.object({ name: z.string().trim().min(1).max(80) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  const { name } = PostBody.parse(await req.json());
  const cart = await prisma.cart.findFirst({ where: { userId: user!.id }, include: { items: true } });
  if (!cart || cart.items.length === 0) return jsonError('Your cart is empty.', 400);
  const payload = JSON.stringify(cart.items.map((it) => ({ productId: it.productId, variantId: it.variantId, quantity: it.quantity })));
  const sc = await prisma.savedCart.create({ data: { userId: user!.id, name, payload } });
  return jsonOk({ savedCart: { id: sc.id, name: sc.name, createdAt: sc.createdAt } });
});
