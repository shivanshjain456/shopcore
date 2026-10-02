/**
 * Express ("Buy Now") checkout session — server-side, isolated from the Cart.
 *
 * ── DESIGN ────────────────────────────────────────────────────────────────
 *
 * One row per user in the `ExpressCheckout` table (`@@unique([userId])`).
 * Rapid clicks UPSERT the same row → no duplicates, no race storms.
 *
 * The express row is the single source of truth for the Buy-Now payload:
 *   { productId, variantId, quantity, expiresAt, consumedAt }
 *
 * We DO NOT trust the cookie in isolation — every consumer reads the row
 * by (userId, cookieId) so a stolen cookie value can't reach another user's
 * express slot.
 *
 * Lifecycle:
 *   1. POST /api/checkout/express  → create/upsert + set sc_express cookie
 *   2. GET  /api/checkout/summary  → if cookie present + valid row, totals
 *                                    are computed from THIS row instead of
 *                                    the user's Cart
 *   3. POST /api/checkout/place-order  → placeOrder({source:'express'}) reads
 *                                    THIS row inside the order tx, fetches
 *                                    fresh prices from the DB, decrements
 *                                    stock, and marks the row consumed.
 *                                    The user's Cart is never read or
 *                                    written by this path.
 *   4. Cookie cleared on success OR explicit abandon (DELETE endpoint).
 *
 * Stock + pricing safety: every existing protection still applies — Bug #5
 * stock validation runs inside the same Prisma tx; Bug #3 price integrity
 * re-reads price from DB inside the tx; Bug #4 idempotency wraps the
 * place-order endpoint; Bug #6 UTR validation gates payment; Bug #7
 * refresh-token-revoked session gets rejected by `getCurrentUser()`.
 * ──────────────────────────────────────────────────────────────────────── */
import { prisma } from '@/lib/db/client';
import { cookies } from 'next/headers';
import { env } from '@/lib/config';
import { safeStock } from '@/lib/catalog/cart';
import { effectivePricePaise, mrpPaise, type PriceContext } from '@/lib/catalog/pricing';
import { log } from '@/lib/log';
import type { CartView, CartLineView } from '@/lib/catalog/cart';

export const EXPRESS_COOKIE = 'sc_express';
/** Default TTL — same lifetime as a sensible checkout abandonment window. */
export const EXPRESS_TTL_SECONDS = 60 * 60; // 1 hour

export interface ExpressUpsertInput {
  userId: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export type ExpressUpsertResult =
  | { ok: true; id: string; expiresAt: Date }
  | { ok: false; code: ExpressErrorCode; reason: string; details?: Record<string, unknown> };

export type ExpressErrorCode =
  | 'INVALID_QUANTITY'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'VARIANT_REQUIRED'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_INACTIVE'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK';

/**
 * Validate + upsert the user's express checkout slot. Reuses the Bug #5
 * stock-validation rules EXACTLY (same `safeStock`, same active flags,
 * same per-line cap). Returns a structured rejection with the same code
 * vocabulary so the client can localise messages.
 */
export async function upsertExpressCheckout(
  input: ExpressUpsertInput,
): Promise<ExpressUpsertResult> {
  const qty = input.quantity;
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 1 || Math.floor(qty) !== qty) {
    return { ok: false, code: 'INVALID_QUANTITY', reason: 'Quantity must be a whole number ≥ 1.' };
  }
  // Reuse the same per-line caps as the cart (B2B=500, B2C=10).
  const user = await prisma.user.findUnique({
    where: { id: input.userId }, select: { role: true, b2bApprovedAt: true },
  });
  const maxPerLine = user?.role === 'B2B' && user.b2bApprovedAt ? 500 : 10;
  if (qty > maxPerLine) {
    return {
      ok: false, code: 'INSUFFICIENT_STOCK',
      reason: `You can order at most ${maxPerLine} of this item at a time.`,
      details: { maxPerLine, requested: qty },
    };
  }

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { variants: true },
  });
  if (!product) {
    return { ok: false, code: 'PRODUCT_NOT_FOUND', reason: 'This product is no longer available.' };
  }
  if (!product.isActive) {
    return { ok: false, code: 'PRODUCT_INACTIVE', reason: 'This product has been discontinued.' };
  }

  let variantId: string | null = input.variantId ?? null;
  let stock = safeStock(product.stock);
  let variantName: string | null = null;

  if (product.variants.length > 0) {
    if (!variantId) {
      return { ok: false, code: 'VARIANT_REQUIRED', reason: 'Please choose a variant before continuing.' };
    }
    const v = product.variants.find((x) => x.id === variantId);
    if (!v) {
      return { ok: false, code: 'VARIANT_NOT_FOUND', reason: 'The variant you selected is no longer available.' };
    }
    if (!v.isActive) {
      return { ok: false, code: 'VARIANT_INACTIVE', reason: 'The variant you selected has been discontinued.' };
    }
    stock = safeStock(v.stock);
    variantName = v.name ?? null;
  } else {
    variantId = null;
  }

  const label = variantName ? `${product.name} — ${variantName}` : product.name;
  if (stock <= 0) {
    return {
      ok: false, code: 'OUT_OF_STOCK',
      reason: `"${label}" is out of stock.`, details: { available: 0 },
    };
  }
  if (qty > stock) {
    return {
      ok: false, code: 'INSUFFICIENT_STOCK',
      reason: `Only ${stock} of "${label}" available — you requested ${qty}.`,
      details: { available: stock, requested: qty },
    };
  }

  const expiresAt = new Date(Date.now() + EXPRESS_TTL_SECONDS * 1000);

  // Upsert by userId — rapid clicks update the same row, never duplicate.
  const row = await prisma.expressCheckout.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId, productId: input.productId, variantId,
      quantity: qty, expiresAt,
    },
    update: {
      productId: input.productId, variantId, quantity: qty,
      expiresAt, consumedAt: null,
    },
  });

  return { ok: true, id: row.id, expiresAt };
}

/**
 * Read the active express row for the current request. Returns null when:
 *   - cookie missing
 *   - row absent / belongs to a different user
 *   - row consumed / expired
 *
 * Server-side validation: the cookie's id MUST correspond to a row owned
 * by the current user. We never accept the cookie alone.
 */
export async function readExpressForUser(userId: string): Promise<{ id: string; productId: string; variantId: string | null; quantity: number; expiresAt: Date } | null> {
  const cookieId = cookies().get(EXPRESS_COOKIE)?.value ?? null;
  if (!cookieId) return null;
  const row = await prisma.expressCheckout.findUnique({ where: { id: cookieId } });
  if (!row) return null;
  if (row.userId !== userId) {
    log.warn('express.cookie_user_mismatch', { cookieId, userId, rowUserId: row.userId });
    return null;
  }
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return {
    id: row.id, productId: row.productId, variantId: row.variantId,
    quantity: row.quantity, expiresAt: row.expiresAt,
  };
}

/**
 * Build a CartView-shaped slice for the express row so downstream pricing
 * code (`computeCheckoutTotals`, `placeOrder`) can consume it identically
 * to a real cart. We deliberately re-fetch product + variant fresh from
 * the DB here — price changes between PDP load and Buy Now click are
 * caught by this path (the edge-case "price changed" requirement).
 */
export async function buildExpressCartView(params: {
  userId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  ctx: PriceContext;
}): Promise<CartView> {
  const product = await prisma.product.findUnique({
    where: { id: params.productId },
    include: {
      images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      variants: params.variantId ? { where: { id: params.variantId } } : false,
    },
  });
  if (!product || !product.isActive) {
    // Empty cart view — downstream code treats this as "your cart is empty"
    // and refuses the order. Strictly safer than throwing here.
    return { id: null, items: [], itemCount: 0, unitCount: 0, subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0 };
  }
  const variant = params.variantId
    ? (product.variants ?? []).find((v) => v.id === params.variantId) ?? null
    : null;
  if (params.variantId && (!variant || !variant.isActive)) {
    return { id: null, items: [], itemCount: 0, unitCount: 0, subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0 };
  }

  const unit = effectivePricePaise(variant ?? product, params.ctx);
  const mrp  = mrpPaise(variant ?? product);
  const stock = safeStock(variant ? variant.stock : product.stock);
  const inStock = stock > 0 && product.isActive && (variant ? variant.isActive : true);

  const line: CartLineView = {
    id: `express:${product.id}:${variant?.id ?? 'novar'}`,
    productId: product.id,
    variantId: variant?.id ?? null,
    productName: product.name,
    variantName: variant?.name ?? null,
    slug: product.slug,
    imageUrl: product.images[0]?.url ?? null,
    unitPricePaise: unit,
    mrpPaise: mrp,
    quantity: params.quantity,
    lineTotalPaise: unit * params.quantity,
    stock,
    inStock,
  };
  return {
    id: null,
    items: [line],
    itemCount: 1,
    unitCount: params.quantity,
    subtotalPaise: line.lineTotalPaise,
    mrpTotalPaise: mrp * params.quantity,
    savingsPaise: Math.max(0, (mrp - unit) * params.quantity),
  };
}

/** Mark the express row consumed (called inside the order tx). */
export async function consumeExpressCheckout(
  tx: { expressCheckout: { update: (args: { where: { id: string }; data: { consumedAt: Date } }) => Promise<unknown> } },
  id: string,
): Promise<void> {
  await tx.expressCheckout.update({
    where: { id }, data: { consumedAt: new Date() },
  });
}

/** Set the cookie. Path=/ so the checkout page sees it. HttpOnly + SameSite=Strict. */
export function setExpressCookie(id: string, expiresAt: Date): void {
  cookies().set(EXPRESS_COOKIE, id, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}
export function clearExpressCookie(): void {
  cookies().set(EXPRESS_COOKIE, '', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

/** Cron-time cleanup. Removes rows whose expiry passed > 7d ago. */
export async function pruneExpiredExpressCheckouts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 86400 * 1000);
  const r = await prisma.expressCheckout.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return r.count;
}
