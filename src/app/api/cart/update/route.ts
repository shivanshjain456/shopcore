import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { updateCartItem, getCartView } from '@/lib/catalog/cart';
import { serializeCartForApi } from '@/lib/catalog/cartView';
import { priceCtxForUser } from '@/lib/catalog/pricing';
import { getCheckoutLimits } from '@/lib/storeConfig/featureGate';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// .strict() — no price field; server re-reads price from DB on every read.
const Body = z.object({
  itemId:   z.string().min(1),
  quantity: z.number().int().min(0).max(500),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const body = Body.parse(await req.json());

  // Item 8: enforce the admin-configurable per-item quantity cap.
  // Setting quantity = 0 is allowed (it deletes the line) — only
  // non-zero quantities go through the cap.
  if (body.quantity > 0) {
    const limits = await getCheckoutLimits();
    if (body.quantity > limits.maxQuantityPerItem) {
      return jsonError(
        `Maximum ${limits.maxQuantityPerItem} per item.`,
        400,
        { code: 'QUANTITY_LIMIT_EXCEEDED', max: limits.maxQuantityPerItem },
      );
    }
  }

  const r = await updateCartItem({ userId: user.id, ...body });
  if (!r.ok) {
    const status = r.code === 'ITEM_NOT_FOUND' ? 404 : 400;
    return jsonError(r.reason, status, { code: r.code, ...(r.details ?? {}) });
  }
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const view = await getCartView(user.id, priceCtxForUser(user, tier));
  return jsonOk(serializeCartForApi(view));
});
