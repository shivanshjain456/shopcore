import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { addToCart, getCartView } from '@/lib/catalog/cart';
import { serializeCartForApi } from '@/lib/catalog/cartView';
import { priceCtxForUser } from '@/lib/catalog/pricing';
import { getCheckoutLimits } from '@/lib/storeConfig/featureGate';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// .strict() — no price/total fields accepted; server reads the price from DB.
const Body = z.object({
  productId: z.string().min(1),
  variantId: z.string().nullable().optional(),
  // Wire-level cap = B2B max; addToCart() re-clamps to B2C limit for non-B2B users.
  quantity:  z.number().int().min(1).max(500).default(1),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in to use your cart.', 401);
  const body = Body.parse(await req.json());

  // Item 8: admin-configurable cart limits.
  //   - checkout.maxQuantityPerItem rejects the line itself
  //   - checkout.maxCartItems rejects after the cart has reached its
  //     row cap (computed below after a fast count).
  const limits = await getCheckoutLimits();
  if (body.quantity > limits.maxQuantityPerItem) {
    return jsonError(
      `Maximum ${limits.maxQuantityPerItem} per item.`,
      400,
      { code: 'QUANTITY_LIMIT_EXCEEDED', max: limits.maxQuantityPerItem },
    );
  }
  // Only count when adding a NEW line. The cart-add path may merge into
  // an existing line — `addToCart` handles that internally; we don't
  // want to reject a quantity bump that doesn't add a new row.
  const existingLine = await prisma.cartItem.findFirst({
    where: { cart: { userId: user.id }, productId: body.productId, variantId: body.variantId ?? null },
    select: { id: true },
  });
  if (!existingLine) {
    const currentRows = await prisma.cartItem.count({ where: { cart: { userId: user.id } } });
    if (currentRows >= limits.maxCartItems) {
      return jsonError(
        `Cart full. Maximum ${limits.maxCartItems} distinct items.`,
        400,
        { code: 'CART_FULL', max: limits.maxCartItems },
      );
    }
  }

  const r = await addToCart({ userId: user.id, ...body });
  if (!r.ok) {
    // Inactive / deleted / OOS / insufficient-stock are normal client errors;
    // 400 with a machine-readable `code` + human-readable `error` message.
    // 404 is reserved for "this product/variant doesn't exist at all".
    const status = r.code === 'PRODUCT_NOT_FOUND' || r.code === 'VARIANT_NOT_FOUND' ? 404 : 400;
    return jsonError(r.reason, status, { code: r.code, ...(r.details ?? {}) });
  }
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const view = await getCartView(user.id, priceCtxForUser(user, tier));
  return jsonOk(serializeCartForApi(view));
});
