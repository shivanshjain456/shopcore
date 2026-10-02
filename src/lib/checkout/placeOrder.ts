/**
 * Atomic order placement.
 *
 * Guarantees:
 *  - All prices, taxes, shipping, discounts recomputed server-side from the DB;
 *    nothing trusted from the client beyond addressId, coupon code, UTR, receipt URL.
 *  - Stock is decremented inside the same transaction it is checked in. SQLite
 *    serialises writes so we can't oversell.
 *  - On any failure the transaction aborts → no partial order, no stolen stock.
 *  - The user's cart is cleared as the last step.
 *  - Loyalty points are recorded as a PENDING ledger row (delta=0 on User.loyaltyPoints).
 *    Admin payment-verify in Phase 7 will flip it to a positive credit.
 */
import { prisma } from '@/lib/db/client';
import { effectivePricePaise, priceCtxForUser } from '@/lib/catalog/pricing';
import { evaluateCoupon } from './coupon';
import { getStoreConfig } from './storeConfig';
import { generateOrderNumber } from './orderNumber';
import { adjustLoyalty } from '@/lib/account/loyalty';
import { computeEarnedPoints, toLoyaltyConfig } from '@/lib/account/loyaltyFormula';
import { assertUtrAcceptable, type PaymentMethod } from './utr';
import { log } from '@/lib/log';
import type { User } from '@prisma/client';

export interface PlaceOrderInput {
  user: User;
  shippingAddressId: string;       // must belong to this user
  billingAddressId?: string | null;
  couponCode?: string | null;
  redeemPoints?: number | null;
  paymentMethod?: PaymentMethod;   // UPI | IMPS | NEFT | RTGS — defaults to UPI
  utrNumber: string;
  receiptUrl: string;              // already-uploaded URL (relative path under /api/uploads/…)
  customerNote?: string | null;
  gstinAtOrder?: string | null;    // B2B only
  clientIp?: string | null;        // forensics for UtrSubmission row
  userAgent?: string | null;       // forensics for UtrSubmission row
  /**
   * 'cart' (default) → order is built from the user's Cart table; cart is
   *                    cleared on success.
   * 'express'        → order is built from the user's active ExpressCheckout
   *                    row (Buy-Now). The user's Cart is NEVER read or
   *                    written by this code path. The express row is marked
   *                    consumed on success.
   *
   * Every other security path (price re-read, stock decrement, coupon
   * eval, GST, UTR, idempotency wrapper) runs identically.
   */
  source?: 'cart' | 'express';
}

export type PlaceOrderResult =
  | { ok: true; orderId: string; orderNumber: string; totalPaise: number }
  | { ok: false; reason: string; code?: string };

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const user = input.user;
  const cfg = await getStoreConfig();
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const ctx = priceCtxForUser(user, tier);

  // Pre-check the address belongs to user
  const ship = await prisma.address.findUnique({ where: { id: input.shippingAddressId } });
  if (!ship || ship.userId !== user.id) return { ok: false, reason: 'Shipping address not found.' };
  let bill = ship;
  if (input.billingAddressId && input.billingAddressId !== ship.id) {
    const b = await prisma.address.findUnique({ where: { id: input.billingAddressId } });
    if (!b || b.userId !== user.id) return { ok: false, reason: 'Billing address not found.' };
    bill = b;
  }

  // UTR — sanitise + format + fraud-pattern checks (uniqueness is enforced
  // by the DB UNIQUE constraint inside the transaction below).
  const declaredMethod: PaymentMethod = input.paymentMethod ?? 'UPI';
  const utrCheck = assertUtrAcceptable(input.utrNumber, declaredMethod);
  if (!utrCheck.ok) {
    // Record the rejected attempt for forensics even though no order exists yet.
    try {
      await prisma.utrSubmission.create({
        data: {
          // For rejected-pre-DB attempts we use the raw (sanitised-if-possible)
          // input as the "normalized" key — but suffix with a uniqueness
          // breaker since these rows must not block legitimate later attempts.
          utrNormalized: `REJ:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          utrSubmitted: String(input.utrNumber ?? ''),
          paymentMethod: typeof input.paymentMethod === 'string' ? input.paymentMethod : 'UNKNOWN',
          userId: user.id,
          amountPaise: 0,
          status: utrCheck.code === 'DUPLICATE' ? 'REJECTED_DUPLICATE'
                : utrCheck.code === 'FRAUD_PATTERN' ? 'REJECTED_FRAUD'
                : 'REJECTED_FORMAT',
          rejectReason: utrCheck.reason,
          clientIp: input.clientIp ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    } catch (e) {
      log.warn('utr.reject_log_failed', { userId: user.id, err: (e as Error).message });
    }
    log.warn('utr.rejected', { userId: user.id, code: utrCheck.code, method: String(input.paymentMethod) });
    return { ok: false, reason: utrCheck.reason, code: utrCheck.code };
  }
  const utr = utrCheck.sanitized;
  const paymentMethod = utrCheck.method;

  if (!input.receiptUrl || !input.receiptUrl.startsWith('/api/uploads/')) {
    return { ok: false, reason: 'Please upload your payment receipt.' };
  }

  // Resolve the source AT request entry (before opening the tx) so the express
  // row's product/variant/qty are captured in the same logical step as the
  // cart-read path. Inside the tx we ALWAYS re-load product+variant fresh
  // from the DB — the same Bug #3 invariant applies to both sources.
  const source: 'cart' | 'express' = input.source ?? 'cart';

  try {
    return await prisma.$transaction(async (tx) => {
      // 1) Load source (cart OR express). The shape both paths produce is
      //    `cartItems[]` — array of {product, variant?, quantity} with the
      //    product+variant rows fully hydrated, so the line-building loop
      //    below is identical.
      let cartId: string | null = null;
      let expressRowId: string | null = null;
      let cartItems: Array<{ product: Awaited<ReturnType<typeof tx.product.findUnique>>; variant: Awaited<ReturnType<typeof tx.variant.findUnique>>; quantity: number }> = [];

      if (source === 'express') {
        // Read the express row owned by this user
        const ex = await tx.expressCheckout.findUnique({ where: { userId: user.id } });
        if (!ex || ex.consumedAt || ex.expiresAt.getTime() < Date.now()) {
          return { ok: false as const, reason: 'Your express checkout has expired. Please try again.' };
        }
        const product = await tx.product.findUnique({ where: { id: ex.productId } });
        if (!product) return { ok: false as const, reason: 'This product is no longer available.' };
        const variant = ex.variantId ? await tx.variant.findUnique({ where: { id: ex.variantId } }) : null;
        if (ex.variantId && !variant) {
          return { ok: false as const, reason: 'The variant you selected is no longer available.' };
        }
        expressRowId = ex.id;
        cartItems = [{ product, variant, quantity: ex.quantity }];
      } else {
        const cart = await tx.cart.findFirst({
          where: { userId: user.id },
          include: { items: { include: { product: true, variant: true } } },
        });
        if (!cart || cart.items.length === 0) {
          return { ok: false as const, reason: 'Your cart is empty.' };
        }
        cartId = cart.id;
        cartItems = cart.items.map((it) => ({ product: it.product, variant: it.variant, quantity: it.quantity }));
      }
      void expressRowId; // used after the line-building loop
      void cartId;

      // 2) Build lines + re-check stock + lock current price/tax server-side
      let subtotal = 0;
      let taxTotal = 0;
      const lineCreates: {
        productId: string; variantId: string | null;
        productName: string; variantName: string | null; sku: string;
        unitPricePaise: number; quantity: number; lineTotalPaise: number;
        gstRate: number; taxPaise: number;
      }[] = [];

      for (const it of cartItems) {
        const p = it.product;
        if (!p) return { ok: false as const, reason: 'This product is no longer available.' };
        if (!p.isActive) return { ok: false as const, reason: `“${p.name}” is no longer available.` };

        let stock = p.stock;
        let unit = effectivePricePaise(p, ctx);
        let mrp = p.mrpPaise;
        let sku = p.sku;
        let name = p.name;
        let variantName: string | null = null;

        if (it.variant) {
          const v = it.variant;
          if (!v.isActive) return { ok: false as const, reason: `Variant “${v.name}” is no longer available.` };
          stock = v.stock;
          unit = effectivePricePaise(v, ctx);
          mrp = v.mrpPaise;
          sku = v.sku;
          variantName = v.name;
        }
        void mrp; // captured later if needed

        if (stock < it.quantity) {
          return { ok: false as const, reason: `Only ${stock} of “${name}${variantName ? ' · ' + variantName : ''}” left in stock.` };
        }

        const lineTotal = unit * it.quantity;
        const lineUnitTax = Math.round(unit - unit / (1 + p.gstRate / 100));
        const lineTax = lineUnitTax * it.quantity;

        subtotal += lineTotal;
        taxTotal += lineTax;

        lineCreates.push({
          productId: p.id,
          variantId: it.variant ? it.variant.id : null,
          productName: name,
          variantName,
          sku,
          unitPricePaise: unit,
          quantity: it.quantity,
          lineTotalPaise: lineTotal,
          gstRate: p.gstRate,
          taxPaise: lineTax,
        });
      }

      // 3) Coupon
      let discount = 0;
      let freeShip = false;
      let couponId: string | null = null;
      // Carry the usage limit out of the coupon load so the race-safe
      // increment below can apply it as a conditional `where` clause.
      let couponUsageLimit: number | null = null;
      if (input.couponCode && input.couponCode.trim()) {
        const r = await evaluateCoupon(tx, {
          code: input.couponCode,
          subtotalPaise: subtotal,
          isB2B: ctx.isB2B,
          userId: user.id,
        });
        if (!r.ok) return { ok: false as const, reason: r.reason };
        discount = r.discountPaise;
        freeShip = r.freeShipping;
        couponId = r.coupon.id;
        couponUsageLimit = r.coupon.usageLimit ?? null;
      }

      // 4) Shipping
      let shipping = (cfg.shipping.freeShippingMinPaise && subtotal >= cfg.shipping.freeShippingMinPaise)
        ? 0 : cfg.shipping.defaultShippingPaise;
      if (freeShip) shipping = 0;

      // 4b) Loyalty redeem (server clamps)
      // Item 8: the unified config exposes BOTH the legacy
      // `loyalty.enabled` and the new master `features.loyaltyEnabled`.
      // Both must be ON for any redemption to apply — a master-off
      // wins regardless of the (legacy) sub-toggle.
      const loyaltyMaster =
        (cfg as unknown as { features?: { loyaltyEnabled?: boolean } })
          .features?.loyaltyEnabled ?? true;
      let loyaltyDiscount = 0;
      let loyaltyPointsUsed = 0;
      if (cfg.loyalty.enabled && loyaltyMaster && input.redeemPoints && input.redeemPoints > 0) {
        // re-read user to get current balance
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { loyaltyPoints: true } });
        const requested = Math.min(Math.floor(input.redeemPoints), fresh.loyaltyPoints);
        const valuePaise = requested * cfg.loyalty.redeemValuePaise;
        const cap = Math.max(0, subtotal - discount);
        loyaltyDiscount = Math.min(valuePaise, cap);
        loyaltyPointsUsed = cfg.loyalty.redeemValuePaise > 0
          ? Math.ceil(loyaltyDiscount / cfg.loyalty.redeemValuePaise)
          : 0;
      }

      const total = Math.max(0, subtotal - discount - loyaltyDiscount + shipping);

      // ── PRICE-INTEGRITY INVARIANTS ────────────────────────────────────────
      // Belt-and-braces: assert every monetary value is a non-negative integer
      // and that the totals add up. If any future refactor breaks this, we
      // abort the transaction instead of persisting a wrong number.
      const monetary: Record<string, number> = {
        subtotal, discount, loyaltyDiscount, shipping, taxTotal, total,
      };
      for (const [k, v] of Object.entries(monetary)) {
        if (!Number.isInteger(v) || v < 0) {
          return { ok: false as const, reason: `Internal price-integrity check failed: ${k}=${v}.` };
        }
      }
      const recomputed = Math.max(0, subtotal - discount - loyaltyDiscount + shipping);
      if (recomputed !== total) {
        return { ok: false as const, reason: `Internal price-integrity check failed: total mismatch (${total} vs ${recomputed}).` };
      }
      // Lines must sum to subtotal (paranoia check; cheap)
      const lineSum = lineCreates.reduce((s, l) => s + l.lineTotalPaise, 0);
      if (lineSum !== subtotal) {
        return { ok: false as const, reason: `Internal price-integrity check failed: lineSum ${lineSum} ≠ subtotal ${subtotal}.` };
      }
      // ──────────────────────────────────────────────────────────────────────

      // 5) Order number
      const orderNumber = await generateOrderNumber(tx);

      // 6) Address snapshot (frozen at order time)
      const addressSnapshot = JSON.stringify({
        shipping: {
          fullName: ship.fullName, phone: ship.phone,
          addressLine1: ship.addressLine1, addressLine2: ship.addressLine2,
          city: ship.city, state: ship.state, pinCode: ship.pinCode, country: ship.country,
        },
        billing: bill.id === ship.id ? 'same' : {
          fullName: bill.fullName, phone: bill.phone,
          addressLine1: bill.addressLine1, addressLine2: bill.addressLine2,
          city: bill.city, state: bill.state, pinCode: bill.pinCode, country: bill.country,
        },
      });

      // 6b) LOYALTY EARN — compute now, snapshot on the order so admin-side
      //     `verifyPayment` credits EXACTLY this number even if the formula
      //     changes between placement and verification.
      const loyaltyConf = toLoyaltyConfig(cfg.loyalty as unknown as Record<string, unknown>);
      const earn = computeEarnedPoints(loyaltyConf, {
        subtotalPaise: subtotal,
        discountPaise: discount + loyaltyDiscount,
      });
      const loyaltyFormulaSnapshot = JSON.stringify({
        config: loyaltyConf,
        result: earn,
        computedAt: new Date().toISOString(),
        version: 1,
      });

      // 6.5) Claim the UTR (anti-replay). The UNIQUE constraint on
      //      UtrSubmission.utrNormalized makes a second order with the same
      //      UTR impossible — even under a concurrent race the second
      //      INSERT trips P2002 and the whole transaction aborts.
      let utrSubmissionId: string;
      try {
        const sub = await tx.utrSubmission.create({
          data: {
            utrNormalized: utr,
            utrSubmitted: input.utrNumber,
            paymentMethod,
            userId: user.id,
            amountPaise: total,
            status: 'ACCEPTED',
            clientIp: input.clientIp ?? null,
            userAgent: input.userAgent ?? null,
          },
        });
        utrSubmissionId = sub.id;
      } catch (e: unknown) {
        const code = (e as { code?: string } | undefined)?.code;
        if (code === 'P2002') {
          // Best-effort: record the duplicate attempt OUTSIDE the rolling-back
          // transaction so it survives. We use a synthetic key to dodge the
          // unique constraint.
          throw new UtrDuplicateError(utr);
        }
        throw e;
      }

      // 7) Create order  (note: loyaltyDiscount folded into the existing discountPaise column)
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId: user.id,
          status: 'PENDING_PAYMENT_REVIEW',
          subtotalPaise: subtotal,
          discountPaise: discount + loyaltyDiscount,
          shippingPaise: shipping,
          taxPaise: taxTotal,
          totalPaise: total,
          couponId,
          shippingAddressId: ship.id,
          billingAddressId: bill.id,
          addressSnapshot,
          paymentStatus: 'AWAITING_VERIFICATION',
          paymentMethod,
          utrNumber: utr,
          receiptUrl: input.receiptUrl,
          customerNote: input.customerNote ?? null,
          isB2B: ctx.isB2B,
          gstinAtOrder: ctx.isB2B ? (input.gstinAtOrder ?? user.gstin ?? null) : null,
          loyaltyFormulaSnapshot,
          loyaltyPointsEarned: earn.points,
          items: { create: lineCreates },
          statusHistory: { create: { status: 'PENDING_PAYMENT_REVIEW', note: 'Order placed; awaiting payment verification.' } },
        },
      });

      // 7.5) Back-link the UtrSubmission to the order it ended up paying for.
      await tx.utrSubmission.update({
        where: { id: utrSubmissionId },
        data:  { orderId: order.id },
      });

      // 8) Decrement stock + log.
      //
      // CRITICAL — race-condition-safe stock decrement.
      // The `where: { stock: { gte: qty } }` clause turns the UPDATE
      // into a conditional one: Prisma generates SQL like
      //   UPDATE product SET stock = stock - $qty WHERE id = $id AND stock >= $qty
      // SQLite executes that atomically. If two concurrent orders both
      // read `stock = 1` for the last unit, only one of the UPDATEs
      // matches (the other sees `stock >= qty` fail) — Prisma raises
      // P2025 ("record not found"), which we map to InsufficientStockError
      // and let the transaction roll back. Without this guard, both
      // orders would succeed and stock could go negative.
      //
      // The earlier validation (line 187) checks `stock < it.quantity`
      // but reads + checks outside the UPDATE — there is a window
      // between the validation read and this decrement during which
      // another transaction can take the last unit.
      for (const li of lineCreates) {
        try {
          if (li.variantId) {
            await tx.variant.update({
              where: { id: li.variantId, stock: { gte: li.quantity } },
              data: { stock: { decrement: li.quantity } },
            });
          } else {
            await tx.product.update({
              where: { id: li.productId, stock: { gte: li.quantity } },
              data: { stock: { decrement: li.quantity } },
            });
          }
        } catch (e) {
          // Prisma P2025 = "no row matched" — our conditional `where`
          // (id + stock >= qty) didn't find a row, which means stock
          // dropped below `li.quantity` between the validation read
          // and this decrement. Roll back the transaction with a
          // user-friendly error.
          const code = (e as { code?: string }).code;
          if (code === 'P2025') {
            throw new StockRaceError(li.productId, li.variantId, li.quantity);
          }
          throw e;
        }
        await tx.inventoryLog.create({
          data: {
            productId: li.productId,
            variantId: li.variantId,
            delta: -li.quantity,
            reason: 'ORDER',
            refId: order.id,
            performedBy: user.id,
          },
        });
      }

      // 9) Coupon used count
      if (couponId) {
        // Race-condition-safe coupon increment. `evaluateCoupon` above
        // checked `usedCount < usageLimit`, but that read is decoupled
        // from this UPDATE. Two concurrent orders both passing the
        // check would both increment, allowing usage past the cap.
        // The conditional `where` (id + usedCount < usageLimit OR no
        // limit) makes the UPDATE atomic — Prisma generates SQL with
        // the predicate, SQLite executes it as one statement.
        //
        // We compute the comparison value `usageLimit` BEFORE the
        // UPDATE because Prisma's `where` doesn't support column-vs-
        // column comparisons. The coupon row was already loaded inside
        // evaluateCoupon — we pass it through (refactor below).
        try {
          // Fast-path: if the coupon has no usage limit, no conditional
          // needed. The increment just bumps the counter for analytics.
          if (couponUsageLimit == null) {
            await tx.coupon.update({
              where: { id: couponId },
              data:  { usedCount: { increment: 1 } },
            });
          } else {
            await tx.coupon.update({
              where: { id: couponId, usedCount: { lt: couponUsageLimit } },
              data:  { usedCount: { increment: 1 } },
            });
          }
        } catch (e) {
          // P2025 = another concurrent order just took the last usage.
          // Roll the transaction back with a clean business-failure.
          const code = (e as { code?: string }).code;
          if (code === 'P2025') throw new CouponExhaustedError(couponId);
          throw e;
        }
      }

      // 10a) Loyalty REDEEM (debit happens NOW — this is a customer-facing commitment)
      if (loyaltyPointsUsed > 0) {
        await adjustLoyalty(tx, user.id, -loyaltyPointsUsed, 'REDEEM', order.id);
      }

      // 10b) Loyalty EARN — PENDING marker (delta 0; admin payment-verify will credit
      //      the exact `loyaltyPointsEarned` we already snapshotted on the order).
      if (earn.points > 0) {
        await tx.loyaltyLedger.create({
          data: {
            userId: user.id, delta: 0, reason: 'ORDER_PENDING', refId: order.id,
          },
        });
      }

      // 11) Clear source. Express path NEVER touches the Cart table — the
      //     user's existing cart contents are preserved end-to-end. The
      //     express row is marked consumed (kept for audit + dedupe).
      if (source === 'express') {
        if (expressRowId) {
          await tx.expressCheckout.update({
            where: { id: expressRowId },
            data: { consumedAt: new Date() },
          });
        }
      } else if (cartId) {
        await tx.cartItem.deleteMany({ where: { cartId } });
      }

      // 12) Activity
      await tx.userActivity.create({
        data: {
          userId: user.id,
          action: 'ORDER_PLACED',
          metadata: JSON.stringify({ orderId: order.id, orderNumber, totalPaise: total }),
        },
      });

      return { ok: true as const, orderId: order.id, orderNumber, totalPaise: total };
    }, { maxWait: 15_000, timeout: 30_000 });
  } catch (e) {
    if (e instanceof UtrDuplicateError) {
      // Record the duplicate attempt OUTSIDE the rolled-back transaction so
      // the forensics survive. Use a synthetic key to dodge the same UNIQUE.
      try {
        await prisma.utrSubmission.create({
          data: {
            utrNormalized: `DUP:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            utrSubmitted: input.utrNumber,
            paymentMethod,
            userId: user.id,
            amountPaise: 0,
            status: 'REJECTED_DUPLICATE',
            rejectReason: 'UTR already used for another order.',
            clientIp: input.clientIp ?? null,
            userAgent: input.userAgent ?? null,
          },
        });
      } catch { /* best-effort */ }
      log.warn('utr.duplicate_attempt', { userId: user.id, method: paymentMethod });
      return {
        ok: false,
        code: 'DUPLICATE',
        reason: 'This Transaction ID has already been used for another order. Please double-check the UTR from your bank/UPI app, or contact support if you believe this is an error.',
      };
    }
    if (e instanceof StockRaceError) {
      // The conditional stock decrement detected another concurrent
      // order taking the last unit between our validation read and
      // our UPDATE. Transaction rolled back automatically — return a
      // clean business-failure result. Logged at warn (operationally
      // interesting; not a bug).
      log.warn('placeOrder.stock_race_lost', {
        userId: user.id,
        productId: e.productId,
        variantId: e.variantId,
        requestedQty: e.requestedQty,
      });
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        reason: 'One of the items just sold out while you were placing the order. Please review your cart and try again.',
      };
    }
    if (e instanceof CouponExhaustedError) {
      log.warn('placeOrder.coupon_race_lost', { userId: user.id, couponId: e.couponId });
      return {
        ok: false,
        code: 'COUPON_EXHAUSTED',
        reason: 'This coupon was just claimed by another order. Please remove the code and try again.',
      };
    }
    log.error('placeOrder.failed', { err: e });
    return { ok: false, reason: 'Could not place order. Please try again.' };
  }
}

/** Thrown inside the order-placement transaction when the UTR uniqueness
 *  constraint fires. Causes the entire tx to roll back; handled above. */
class UtrDuplicateError extends Error {
  constructor(public readonly utrNormalized: string) {
    super(`UTR already used: ${utrNormalized}`);
    this.name = 'UtrDuplicateError';
  }
}

/** Thrown inside the order-placement transaction when the conditional
 *  stock-decrement UPDATE matches 0 rows — meaning another concurrent
 *  order took the unit(s) we needed between our validation read and
 *  our atomic UPDATE. Causes the whole tx to roll back; caught by the
 *  outer handler and translated to a friendly "sold out" response. */
class StockRaceError extends Error {
  constructor(
    public readonly productId: string,
    public readonly variantId: string | null,
    public readonly requestedQty: number,
  ) {
    super(`Stock race lost on product=${productId} variant=${variantId ?? 'null'} qty=${requestedQty}`);
    this.name = 'StockRaceError';
  }
}

/** Thrown when the conditional coupon-increment UPDATE matches 0 rows
 *  — another concurrent order consumed the last allowed use. Same
 *  rollback + friendly-message pattern as `StockRaceError`. */
class CouponExhaustedError extends Error {
  constructor(public readonly couponId: string) {
    super(`Coupon usage cap reached: ${couponId}`);
    this.name = 'CouponExhaustedError';
  }
}

/**
 * Customer cancel (allowed per StoreConfig.policies.cancellation).
 * Restores stock + logs inventory + records status history.
 */
export async function customerCancelOrder(userId: string, orderId: string, reason?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cfg = await getStoreConfig();
  if (!cfg.policies.cancellation.enabled) return { ok: false, reason: 'Cancellation is disabled.' };

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.userId !== userId) return { ok: false as const, reason: 'Order not found.' };
    if (!cfg.policies.cancellation.allowedStatuses.includes(order.status)) {
      return { ok: false as const, reason: `Order can no longer be cancelled (status: ${order.status}).` };
    }
    const ageHours = (Date.now() - order.createdAt.getTime()) / 3600_000;
    if (ageHours > cfg.policies.cancellation.windowHours) {
      return { ok: false as const, reason: `Cancellation window (${cfg.policies.cancellation.windowHours}h) has passed.` };
    }

    // Restore stock
    for (const li of order.items) {
      if (li.variantId) {
        await tx.variant.update({ where: { id: li.variantId }, data: { stock: { increment: li.quantity } } });
      } else {
        await tx.product.update({ where: { id: li.productId }, data: { stock: { increment: li.quantity } } });
      }
      await tx.inventoryLog.create({
        data: { productId: li.productId, variantId: li.variantId, delta: li.quantity, reason: 'CANCELLATION', refId: order.id, performedBy: userId },
      });
    }

    // Reverse any REDEEM ledger entry for this order
    const redeem = await tx.loyaltyLedger.findFirst({ where: { userId, reason: 'REDEEM', refId: order.id } });
    if (redeem && redeem.delta < 0) {
      await adjustLoyalty(tx, userId, -redeem.delta, 'REDEEM_REVERSE', order.id);
    }
    // Reverse the PENDING earn marker (no balance change but mark for audit)
    await tx.loyaltyLedger.deleteMany({ where: { userId, reason: 'ORDER_PENDING', refId: order.id } });

    await tx.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', statusHistory: { create: { status: 'CANCELLED', note: reason ?? 'Cancelled by customer', changedBy: userId } } },
    });

    await tx.userActivity.create({
      data: { userId, action: 'ORDER_CANCELLED', metadata: JSON.stringify({ orderId, reason: reason ?? null }) },
    });

    return { ok: true as const };
  });
}
