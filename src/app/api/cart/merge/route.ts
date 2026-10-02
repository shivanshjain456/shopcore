import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { mergeGuestCart, getCartView } from '@/lib/catalog/cart';
import { serializeCartForApi } from '@/lib/catalog/cartView';
import { priceCtxForUser } from '@/lib/catalog/pricing';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// .strict() at both levels — guest cart payloads carry only id+qty; never prices.
const Body = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    variantId: z.string().nullable().optional(),
    quantity:  z.number().int().min(1).max(10),
  }).strict()).max(50),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const body = Body.parse(await req.json());
  const outcomes = await mergeGuestCart(user.id, body.items.map((i) => ({ ...i, variantId: i.variantId ?? null })));
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const view = await getCartView(user.id, priceCtxForUser(user, tier));
  const skipped = outcomes.filter((o) => !o.ok);
  return jsonOk({
    ...serializeCartForApi(view),
    notices: skipped.map((s) => ({ productId: s.productId, variantId: s.variantId, reason: s.reason, code: s.code })),
  });
});
