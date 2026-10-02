/**
 * DELETE → remove a saved cart.
 * POST   → restore: merges the saved cart back into the user's active cart.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { mergeGuestCart } from '@/lib/catalog/cart';

export const dynamic = 'force-dynamic';

async function loadOwn(userId: string, id: string) {
  const s = await prisma.savedCart.findUnique({ where: { id } });
  if (!s || s.userId !== userId) return null;
  return s;
}

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const s = await loadOwn(user.id, params.id);
  if (!s) return jsonError('Not found.', 404);
  await prisma.savedCart.delete({ where: { id: s.id } });
  return jsonOk({ deleted: true });
});

export const POST = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const s = await loadOwn(user.id, params.id);
  if (!s) return jsonError('Not found.', 404);
  const items = JSON.parse(s.payload) as Array<{ productId: string; variantId: string | null; quantity: number }>;
  await mergeGuestCart(user.id, items);
  return jsonOk({ restored: true, count: items.length });
});
