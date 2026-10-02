/**
 * Cart engine — stock-aware, transactional, idempotent.
 *
 * ── STOCK-VALIDATION CONTRACT ─────────────────────────────────────────────
 * Every mutation re-reads inventory inside the same Prisma transaction and
 * refuses to silently clamp.  Concretely:
 *
 *   1. The product MUST exist and be `isActive`.
 *   2. If the product has variants, a valid `variantId` MUST be supplied and
 *      that variant MUST be `isActive`.
 *   3. Stock is read fresh from DB inside the tx (Product.stock or
 *      Variant.stock — see `effectiveStockFor()`).  `null` / `undefined` is
 *      treated as **0** ("fail safe"), never infinity.
 *   4. The combined quantity (already-in-cart + newly requested) MUST NOT
 *      exceed available stock — if it does, the request is **rejected** with
 *      a specific error message; we never partially apply.
 *   5. The per-line cap (B2C=10, B2B=500) is enforced the same way: blowing
 *      past it is a rejection, not a silent clamp.
 *   6. Concurrent calls serialise inside the transaction (SQLite single
 *      writer + Prisma BEGIN IMMEDIATE).  A final post-write invariant
 *      assertion guarantees the persisted quantity never exceeds stock.
 *
 * Stock is NEVER decremented at cart time.  Decrement happens only when an
 * order is confirmed and paid (`placeOrder()` / admin verify-payment).
 *
 * Regression suite: `scripts/test-stock-validation.ts`.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Strategy:
 *  - One Cart per user (created lazily).
 *  - CartItem has @@unique([cartId, productId, variantId]) → findFirst+update.
 *  - All mutations run inside a single Prisma transaction so we never go
 *    half-applied; stock checks happen inside the transaction too.
 *  - Guests cart in localStorage; on login a merge endpoint splices it in.
 */
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
import { effectivePricePaise, mrpPaise, type PriceContext } from './pricing';
import { log } from '@/lib/log';

export const MAX_QTY_PER_LINE_B2C = 10;
export const MAX_QTY_PER_LINE_B2B = 500;
/** Back-compat constant used in places that pre-dated the B2B split. */
export const MAX_QTY_PER_LINE = MAX_QTY_PER_LINE_B2C;

async function maxQtyFor(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, b2bApprovedAt: true } });
  return u?.role === 'B2B' && u.b2bApprovedAt ? MAX_QTY_PER_LINE_B2B : MAX_QTY_PER_LINE_B2C;
}

export interface CartLineView {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  slug: string;
  imageUrl: string | null;
  unitPricePaise: number;
  mrpPaise: number;
  quantity: number;
  lineTotalPaise: number;
  stock: number;
  inStock: boolean;
}

export interface CartView {
  id: string | null;
  items: CartLineView[];
  itemCount: number;            // distinct lines
  unitCount: number;            // sum of quantities
  subtotalPaise: number;
  mrpTotalPaise: number;
  savingsPaise: number;
}

export const EMPTY_CART: CartView = {
  id: null, items: [], itemCount: 0, unitCount: 0,
  subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0,
};

async function ensureCart(userId: string, tx?: Prisma.TransactionClient) {
  const db = tx ?? prisma;
  const existing = await db.cart.findFirst({ where: { userId } });
  if (existing) return existing;
  return db.cart.create({ data: { userId } });
}

export async function getCartView(userId: string, ctx: PriceContext): Promise<CartView> {
  const cart = await prisma.cart.findFirst({
    where: { userId },
    include: {
      items: {
        include: {
          product: { include: { images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } } },
          variant: true,
        },
      },
    },
  });
  if (!cart) return EMPTY_CART;

  const lines: CartLineView[] = cart.items.map((it) => {
    const unit = effectivePricePaise(it.variant ?? it.product, ctx);
    const mrp  = mrpPaise(it.variant ?? it.product);
    const stock = it.variant ? it.variant.stock : it.product.stock;
    return {
      id: it.id,
      productId: it.productId,
      variantId: it.variantId,
      productName: it.product.name,
      variantName: it.variant?.name ?? null,
      slug: it.product.slug,
      imageUrl: it.product.images[0]?.url ?? null,
      unitPricePaise: unit,
      mrpPaise: mrp,
      quantity: it.quantity,
      lineTotalPaise: unit * it.quantity,
      stock,
      inStock: stock > 0 && it.product.isActive && (it.variant ? it.variant.isActive : true),
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const mrpTotal = lines.reduce((s, l) => s + l.mrpPaise * l.quantity, 0);

  return {
    id: cart.id,
    items: lines,
    itemCount: lines.length,
    unitCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotalPaise: subtotal,
    mrpTotalPaise: mrpTotal,
    savingsPaise: Math.max(0, mrpTotal - subtotal),
  };
}

/**
 * Safely interpret a stock column as a non-negative integer.
 * Treats null/undefined/NaN/negative as 0 — NEVER as infinite.
 * "Null Inventory" → fail safely (per the bug spec).
 */
export function safeStock(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  return Math.floor(raw);
}

/** Pretty product label for error messages — never leak internal IDs. */
function labelFor(productName: string, variantName: string | null): string {
  return variantName ? `${productName} — ${variantName}` : productName;
}

export type CartMutationResult =
  | { ok: true; line: { quantity: number; productId: string; variantId: string | null; stockRemaining: number } }
  | { ok: false; reason: string; code: CartErrorCode; details?: Record<string, unknown> };

export type CartErrorCode =
  | 'INVALID_QUANTITY'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'VARIANT_REQUIRED'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_INACTIVE'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'LINE_LIMIT_EXCEEDED'
  | 'ITEM_NOT_FOUND'
  | 'INTERNAL';

/**
 * In-process per-user serialisation. SQLite already serialises writes at the
 * file level, but Prisma's interactive-tx queue isn't fair under burst load:
 * concurrent calls for the same user race for the same connection-pool slot
 * AND the BEGIN IMMEDIATE lock, and some are starved out hitting the 5s/15s
 * tx timeout. This lock makes the per-user contention path deterministic —
 * N concurrent add-to-cart calls for the same user run one at a time, in
 * arrival order, so every request gets a fair turn.
 *
 * Cross-process safety is still provided by the DB transaction + the
 * post-write invariant assertion (`InventoryRaceError`).
 */
const userLocks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve<unknown>(undefined);
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const ours = prev.then(() => gate);
  userLocks.set(userId, ours);
  try {
    await prev.catch(() => { /* prior holder failed; we still proceed */ });
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === ours) userLocks.delete(userId);
  }
}

export async function addToCart(params: {
  userId: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
}): Promise<CartMutationResult> {
  // Validate quantity at the boundary — reject 0/negative/non-integer.
  const rawQty = params.quantity;
  if (typeof rawQty !== 'number' || !Number.isFinite(rawQty) || rawQty < 1 || Math.floor(rawQty) !== rawQty) {
    return { ok: false, code: 'INVALID_QUANTITY' as CartErrorCode, reason: 'Quantity must be a whole number ≥ 1.' };
  }
  const qty = rawQty;

  const maxPerLine = await maxQtyFor(params.userId);

  return withUserLock(params.userId, () => addToCartTx(params, qty, maxPerLine));
}

async function addToCartTx(
  params: { userId: string; productId: string; variantId?: string | null; quantity: number },
  qty: number,
  maxPerLine: number,
): Promise<CartMutationResult> {
  // Single-flight via withUserLock above + DB transaction here. This means
  // no SQLite write contention for the same user; the BEGIN IMMEDIATE
  // serialiser only sees one writer per user at a time.
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: params.productId },
      include: { variants: true },
    });
    if (!product) {
      return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as CartErrorCode, reason: 'This product is no longer available.' };
    }
    if (!product.isActive) {
      return { ok: false as const, code: 'PRODUCT_INACTIVE' as CartErrorCode, reason: 'This product has been discontinued.' };
    }

    let variantId: string | null = params.variantId ?? null;
    let stock = safeStock(product.stock);
    let variantName: string | null = null;

    if (product.variants.length > 0) {
      if (!variantId) {
        return { ok: false as const, code: 'VARIANT_REQUIRED' as CartErrorCode, reason: 'Please choose a variant before adding to cart.' };
      }
      const v = product.variants.find((x) => x.id === variantId);
      if (!v) {
        return { ok: false as const, code: 'VARIANT_NOT_FOUND' as CartErrorCode, reason: 'The variant you selected is no longer available.' };
      }
      if (!v.isActive) {
        return { ok: false as const, code: 'VARIANT_INACTIVE' as CartErrorCode, reason: 'The variant you selected has been discontinued.' };
      }
      stock = safeStock(v.stock);
      variantName = v.name ?? null;
    } else {
      variantId = null;
    }

    const label = labelFor(product.name, variantName);

    if (stock <= 0) {
      return {
        ok: false as const,
        code: 'OUT_OF_STOCK' as CartErrorCode,
        reason: `"${label}" is out of stock.`,
        details: { available: 0 },
      };
    }

    const cart = await ensureCart(params.userId, tx);

    const existing = await tx.cartItem.findFirst({
      where: { cartId: cart.id, productId: params.productId, variantId },
    });
    const already = existing?.quantity ?? 0;
    const desired = already + qty;

    // Per-line cap → REJECT (no silent clamp).
    if (desired > maxPerLine) {
      const canAdd = Math.max(0, maxPerLine - already);
      return {
        ok: false as const,
        code: 'LINE_LIMIT_EXCEEDED' as CartErrorCode,
        reason:
          already > 0
            ? `You can have at most ${maxPerLine} of "${label}" per order. You already have ${already}; ${canAdd > 0 ? `you can add ${canAdd} more` : 'remove some first'}.`
            : `You can order at most ${maxPerLine} of "${label}" at a time.`,
        details: { maxPerLine, already, canAdd },
      };
    }

    // Stock cap → REJECT (no silent clamp).
    if (desired > stock) {
      const canAdd = Math.max(0, stock - already);
      return {
        ok: false as const,
        code: 'INSUFFICIENT_STOCK' as CartErrorCode,
        reason:
          already > 0
            ? `Only ${stock} of "${label}" available. You already have ${already} in your cart; ${canAdd > 0 ? `you can add ${canAdd} more` : 'no more can be added'}.`
            : `Only ${stock} of "${label}" available — you requested ${qty}.`,
        details: { available: stock, already, requested: qty, canAdd },
      };
    }

    const line = existing
      ? await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: desired } })
      : await tx.cartItem.create({ data: { cartId: cart.id, productId: params.productId, variantId, quantity: desired } });

    // Post-write invariant: re-read stock + line and confirm we are within
    // bounds. If a concurrent admin write reduced stock between our read and
    // our write, roll back instead of leaving a corrupt cart.
    const verifyStock = variantId
      ? safeStock((await tx.variant.findUnique({ where: { id: variantId } }))?.stock)
      : safeStock((await tx.product.findUnique({ where: { id: params.productId } }))?.stock);
    if (line.quantity > verifyStock) {
      log.warn('cart.invariant_violation_rollback', {
        userId: params.userId, productId: params.productId, variantId,
        wrote: line.quantity, available: verifyStock,
      });
      // Throw to abort the transaction — caller gets a clean error.
      throw new InventoryRaceError(
        `Inventory changed during your request — only ${verifyStock} of "${label}" available now.`,
        verifyStock,
      );
    }

    return {
      ok: true as const,
      line: {
        quantity: line.quantity,
        productId: params.productId,
        variantId,
        stockRemaining: Math.max(0, verifyStock - line.quantity),
      },
    };
  }, { maxWait: 15_000, timeout: 15_000 }).catch((e: unknown) => {
    if (e instanceof InventoryRaceError) {
      return { ok: false as const, code: 'INSUFFICIENT_STOCK' as CartErrorCode, reason: e.message, details: { available: e.available } };
    }
    throw e;
  });
}

/** Internal — thrown inside the tx to abort + roll back when a concurrent
 *  inventory change made our write invalid between the read and the write. */
class InventoryRaceError extends Error {
  constructor(message: string, public readonly available: number) {
    super(message);
    this.name = 'InventoryRaceError';
  }
}

export async function updateCartItem(params: {
  userId: string;
  itemId: string;
  quantity: number;
}): Promise<{ ok: true; quantity: number } | { ok: false; reason: string; code: CartErrorCode; details?: Record<string, unknown> }> {
  const rawQty = params.quantity;
  if (typeof rawQty !== 'number' || !Number.isFinite(rawQty) || rawQty < 0 || Math.floor(rawQty) !== rawQty) {
    return { ok: false, code: 'INVALID_QUANTITY' as CartErrorCode, reason: 'Quantity must be a whole number ≥ 0 (use 0 to remove).' };
  }
  const qty = rawQty;
  const maxPerLine = await maxQtyFor(params.userId);

  return withUserLock(params.userId, () => prisma.$transaction(async (tx) => {
    const item = await tx.cartItem.findUnique({
      where: { id: params.itemId },
      include: { cart: true, product: true, variant: true },
    });
    if (!item || item.cart.userId !== params.userId) {
      return { ok: false as const, code: 'ITEM_NOT_FOUND' as CartErrorCode, reason: 'Item not found in your cart.' };
    }

    if (qty === 0) {
      await tx.cartItem.delete({ where: { id: item.id } });
      return { ok: true as const, quantity: 0 };
    }

    // The product/variant may have been deactivated since the line was added.
    if (!item.product.isActive) {
      return { ok: false as const, code: 'PRODUCT_INACTIVE' as CartErrorCode, reason: `"${item.product.name}" has been discontinued.` };
    }
    if (item.variant && !item.variant.isActive) {
      return { ok: false as const, code: 'VARIANT_INACTIVE' as CartErrorCode, reason: `The selected variant of "${item.product.name}" has been discontinued.` };
    }

    const label = labelFor(item.product.name, item.variant?.name ?? null);
    const stock = safeStock(item.variant ? item.variant.stock : item.product.stock);

    if (qty > maxPerLine) {
      return {
        ok: false as const,
        code: 'LINE_LIMIT_EXCEEDED' as CartErrorCode,
        reason: `You can order at most ${maxPerLine} of "${label}" at a time.`,
        details: { maxPerLine, requested: qty },
      };
    }
    if (stock <= 0) {
      return { ok: false as const, code: 'OUT_OF_STOCK' as CartErrorCode, reason: `"${label}" is out of stock.`, details: { available: 0 } };
    }
    if (qty > stock) {
      return {
        ok: false as const,
        code: 'INSUFFICIENT_STOCK' as CartErrorCode,
        reason: `Only ${stock} of "${label}" available — you requested ${qty}.`,
        details: { available: stock, requested: qty },
      };
    }

    await tx.cartItem.update({ where: { id: item.id }, data: { quantity: qty } });
    return { ok: true as const, quantity: qty };
  }, { maxWait: 15_000, timeout: 15_000 }));
}

export async function removeCartItem(userId: string, itemId: string) {
  const item = await prisma.cartItem.findUnique({ where: { id: itemId }, include: { cart: true } });
  if (!item || item.cart.userId !== userId) return { ok: false as const, reason: 'Item not found.' };
  await prisma.cartItem.delete({ where: { id: itemId } });
  return { ok: true as const };
}

export async function clearCart(userId: string) {
  const cart = await prisma.cart.findFirst({ where: { userId } });
  if (!cart) return;
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
}

/**
 * Merge a guest cart (from localStorage) into the user's server cart on login.
 * Returns the per-line outcomes so callers can surface "X items couldn't be
 * added because they're out of stock / discontinued" notices.
 *
 * Best-effort: failed merges DON'T abort the whole merge — we keep going so
 * the user gets as much of their cart as possible.
 */
export interface GuestMergeOutcome {
  productId: string;
  variantId: string | null;
  requested: number;
  ok: boolean;
  reason?: string;
  code?: CartErrorCode;
}
export async function mergeGuestCart(
  userId: string,
  guestItems: Array<{ productId: string; variantId?: string | null; quantity: number }>,
): Promise<GuestMergeOutcome[]> {
  const out: GuestMergeOutcome[] = [];
  for (const gi of guestItems) {
    if (!gi.productId || !gi.quantity || gi.quantity < 1) continue;
    const qty = Math.max(1, Math.floor(gi.quantity));
    const r = await addToCart({
      userId,
      productId: gi.productId,
      variantId: gi.variantId ?? null,
      quantity: qty,
    });
    out.push({
      productId: gi.productId, variantId: gi.variantId ?? null, requested: qty,
      ok: r.ok, reason: r.ok ? undefined : r.reason, code: r.ok ? undefined : r.code,
    });
  }
  return out;
}
