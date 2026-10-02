import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const subs = await prisma.subscription.findMany({
    where: { userId: user.id }, orderBy: { createdAt: 'desc' },
    include: {
      // join hand-rolled to avoid extra relations
    },
  });
  const productIds = Array.from(new Set(subs.map((s) => s.productId)));
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, slug: true, images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } },
  });
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  return jsonOk({ subscriptions: subs.map((s) => ({
    id: s.id, productId: s.productId, variantId: s.variantId, quantity: s.quantity,
    intervalDays: s.intervalDays, nextOrderAt: s.nextOrderAt, isActive: s.isActive,
    product: byId[s.productId] ? { id: byId[s.productId].id, name: byId[s.productId].name, slug: byId[s.productId].slug, imageUrl: byId[s.productId].images[0]?.url ?? null } : null,
  })) });
});

const Body = z.object({
  productId:    z.string().min(1),
  variantId:    z.string().nullable().optional(),
  quantity:     z.number().int().min(1).max(10),
  intervalDays: z.number().int().min(7).max(180),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const data = Body.parse(await req.json());
  const p = await prisma.product.findUnique({ where: { id: data.productId } });
  if (!p || !p.isActive) return jsonError('Product unavailable.', 400);
  const sub = await prisma.subscription.create({
    data: {
      userId: user.id, productId: data.productId, variantId: data.variantId ?? null,
      quantity: data.quantity, intervalDays: data.intervalDays,
      nextOrderAt: new Date(Date.now() + data.intervalDays * 86400_000),
      isActive: true,
    },
  });
  return jsonOk({ id: sub.id });
});
