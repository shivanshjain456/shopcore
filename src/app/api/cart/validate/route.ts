/**
 * POST /api/cart/validate
 *
 * Stateless server-side stock check used by the GUEST cart flow (and any
 * client surface that wants to gate Add-to-Cart on real-time inventory).
 *
 * Authenticated users use POST /api/cart/add directly — it performs the same
 * validation inside a transaction AND mutates the cart.  This endpoint is
 * the read-only equivalent for guests:
 *
 *   Input:
 *     { productId, variantId?, quantity, alreadyInCart? }
 *
 *   Output (200 ok):
 *     { ok: true, available: number, label: string }
 *   Output (400 fail):
 *     { ok: false, error: "...", code: "OUT_OF_STOCK"|... , available, ... }
 *
 * The client uses this to decide whether to mutate localStorage. It does
 * NOT replace any server-side check on subsequent operations — every cart
 * mutation re-validates regardless.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { prisma } from '@/lib/db/client';
import { safeStock, MAX_QTY_PER_LINE_B2C } from '@/lib/catalog/cart';

export const dynamic = 'force-dynamic';

const Body = z.object({
  productId:     z.string().min(1),
  variantId:     z.string().nullable().optional(),
  quantity:      z.number().int().min(1).max(500),
  alreadyInCart: z.number().int().min(0).max(500).optional().default(0),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  const { productId, variantId, quantity, alreadyInCart } = Body.parse(await req.json());

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: true },
  });
  if (!product) {
    return jsonError('This product is no longer available.', 404, { code: 'PRODUCT_NOT_FOUND' });
  }
  if (!product.isActive) {
    return jsonError('This product has been discontinued.', 400, { code: 'PRODUCT_INACTIVE' });
  }

  let variantName: string | null = null;
  let stock = safeStock(product.stock);
  let resolvedVariantId: string | null = null;

  if (product.variants.length > 0) {
    if (!variantId) {
      return jsonError('Please choose a variant before adding to cart.', 400, { code: 'VARIANT_REQUIRED' });
    }
    const v = product.variants.find((x) => x.id === variantId);
    if (!v) {
      return jsonError('The variant you selected is no longer available.', 404, { code: 'VARIANT_NOT_FOUND' });
    }
    if (!v.isActive) {
      return jsonError('The variant you selected has been discontinued.', 400, { code: 'VARIANT_INACTIVE' });
    }
    stock = safeStock(v.stock);
    variantName = v.name ?? null;
    resolvedVariantId = v.id;
  }

  const label = variantName ? `${product.name} — ${variantName}` : product.name;

  if (stock <= 0) {
    return jsonError(`"${label}" is out of stock.`, 400, { code: 'OUT_OF_STOCK', available: 0 });
  }

  const desired = alreadyInCart + quantity;

  // Guest carts honour the B2C cap (B2B accounts use the authed flow).
  if (desired > MAX_QTY_PER_LINE_B2C) {
    const canAdd = Math.max(0, MAX_QTY_PER_LINE_B2C - alreadyInCart);
    return jsonError(
      alreadyInCart > 0
        ? `You can have at most ${MAX_QTY_PER_LINE_B2C} of "${label}" per order. You already have ${alreadyInCart}; ${canAdd > 0 ? `you can add ${canAdd} more` : 'remove some first'}.`
        : `You can order at most ${MAX_QTY_PER_LINE_B2C} of "${label}" at a time.`,
      400,
      { code: 'LINE_LIMIT_EXCEEDED', maxPerLine: MAX_QTY_PER_LINE_B2C, alreadyInCart, canAdd },
    );
  }

  if (desired > stock) {
    const canAdd = Math.max(0, stock - alreadyInCart);
    return jsonError(
      alreadyInCart > 0
        ? `Only ${stock} of "${label}" available. You already have ${alreadyInCart} in your cart; ${canAdd > 0 ? `you can add ${canAdd} more` : 'no more can be added'}.`
        : `Only ${stock} of "${label}" available — you requested ${quantity}.`,
      400,
      { code: 'INSUFFICIENT_STOCK', available: stock, alreadyInCart, requested: quantity, canAdd },
    );
  }

  return jsonOk({
    productId, variantId: resolvedVariantId, label,
    available: stock,
    maxPerLine: MAX_QTY_PER_LINE_B2C,
    stockRemaining: Math.max(0, stock - desired),
  });
});
