/**
 * Read-only totals calculator for the checkout review screen.
 * Re-uses the cart engine so the numbers shown on /checkout exactly match
 * what placeOrder() will compute (they share priceCtxForUser + DB reads).
 */
import { prisma } from '@/lib/db/client';
import { getCartView } from '@/lib/catalog/cart';
import { priceCtxForUser } from '@/lib/catalog/pricing';
import { evaluateCoupon } from './coupon';
import { getStoreConfig } from './storeConfig';
import { readExpressForUser, buildExpressCartView } from './express';
import type { User } from '@prisma/client';

export interface CheckoutTotals {
  subtotalPaise: number;
  discountPaise: number;
  loyaltyDiscountPaise: number;
  loyaltyPointsUsed: number;
  shippingPaise: number;
  taxPaise: number;          // sum of per-line tax (inclusive in price)
  totalPaise: number;
  freeShippingApplied: boolean;
  couponCode: string | null;
  couponError: string | null;
  loyaltyError: string | null;
  items: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPricePaise: number;
    lineTotalPaise: number;
    gstRate: number;
    taxPaise: number;
  }>;
}

export async function computeCheckoutTotals(
  user: Pick<User, 'id' | 'role' | 'b2bTierId' | 'loyaltyPoints'>,
  opts: {
    couponCode?: string | null;
    redeemPoints?: number | null;
    /**
     * 'cart' (default): totals over the user's Cart table — existing flow.
     * 'express': totals over the user's active ExpressCheckout row instead.
     *   If no row is present, the synthetic view is empty — UI shows "your
     *   cart is empty" rather than mixing with the real cart (isolation
     *   contract).
     */
    source?: 'cart' | 'express';
  } = {},
): Promise<CheckoutTotals> {
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const ctx = priceCtxForUser(user, tier);
  const cart = opts.source === 'express'
    ? await (async () => {
        const ex = await readExpressForUser(user.id);
        if (!ex) {
          // Empty view; the caller will surface "your cart is empty".
          return { id: null, items: [], itemCount: 0, unitCount: 0, subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0 };
        }
        return buildExpressCartView({
          userId: user.id, productId: ex.productId, variantId: ex.variantId,
          quantity: ex.quantity, ctx,
        });
      })()
    : await getCartView(user.id, ctx);
  const cfg = await getStoreConfig();

  // Pull GST per product
  const productIds = Array.from(new Set(cart.items.map((i) => i.productId)));
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, gstRate: true },
  });
  const gstById = Object.fromEntries(products.map((p) => [p.id, p.gstRate]));

  // Tax is INCLUSIVE in unitPricePaise (Indian convention). Reverse-compute the tax portion:
  //   priceExTax = unit / (1 + gst/100)
  //   tax = unit - priceExTax
  const items = cart.items.map((it) => {
    const gst = gstById[it.productId] ?? 18;
    const lineUnitTax = Math.round(it.unitPricePaise - it.unitPricePaise / (1 + gst / 100));
    return {
      productId: it.productId,
      variantId: it.variantId,
      productName: it.productName,
      variantName: it.variantName,
      quantity: it.quantity,
      unitPricePaise: it.unitPricePaise,
      lineTotalPaise: it.lineTotalPaise,
      gstRate: gst,
      taxPaise: lineUnitTax * it.quantity,
    };
  });

  const subtotal = cart.subtotalPaise;
  const taxTotal = items.reduce((s, i) => s + i.taxPaise, 0);

  // Coupon (preview only — doesn't mutate or increment usedCount)
  let discount = 0;
  let freeShip = false;
  let couponCode: string | null = null;
  let couponError: string | null = null;

  // Item 8: coupons gated behind features.couponsEnabled. A disabled
  // toggle means we evaluate as if no code was supplied — the total
  // preview path just shows the natural total and a friendly note
  // instead of "invalid code".
  const couponsMaster =
    (cfg as unknown as { features?: { couponsEnabled?: boolean } })
      .features?.couponsEnabled ?? true;
  if (opts.couponCode && subtotal > 0 && couponsMaster) {
    const r = await prisma.$transaction(async (tx) => {
      return evaluateCoupon(tx, {
        code: opts.couponCode!,
        subtotalPaise: subtotal,
        isB2B: ctx.isB2B,
        userId: user.id,
      });
    });
    if (r.ok) {
      discount = r.discountPaise;
      freeShip = r.freeShipping;
      couponCode = r.coupon.code;
    } else {
      couponError = r.reason;
    }
  }

  // Shipping
  let shipping = 0;
  if (subtotal > 0) {
    shipping = (cfg.shipping.freeShippingMinPaise && subtotal >= cfg.shipping.freeShippingMinPaise)
      ? 0 : cfg.shipping.defaultShippingPaise;
    if (freeShip) shipping = 0;
  }

  // Loyalty redeem — capped to (subtotal - couponDiscount) so we never go negative
  let loyaltyPointsUsed = 0;
  let loyaltyDiscount = 0;
  let loyaltyError: string | null = null;
  if (cfg.loyalty.enabled && opts.redeemPoints && opts.redeemPoints > 0) {
    const requested = Math.floor(opts.redeemPoints);
    const maxAvailable = Math.max(0, user.loyaltyPoints);
    const requestedClamped = Math.min(requested, maxAvailable);
    if (requestedClamped < requested) loyaltyError = 'You requested more points than you have.';
    const redeemableValue = requestedClamped * cfg.loyalty.redeemValuePaise;
    const cap = Math.max(0, subtotal - discount);
    loyaltyDiscount = Math.min(redeemableValue, cap);
    loyaltyPointsUsed = cfg.loyalty.redeemValuePaise > 0
      ? Math.ceil(loyaltyDiscount / cfg.loyalty.redeemValuePaise)
      : 0;
  }

  const total = Math.max(0, subtotal - discount - loyaltyDiscount + shipping);

  return {
    subtotalPaise: subtotal,
    discountPaise: discount,
    loyaltyDiscountPaise: loyaltyDiscount,
    loyaltyPointsUsed,
    shippingPaise: shipping,
    taxPaise: taxTotal,
    totalPaise: total,
    freeShippingApplied: freeShip,
    couponCode,
    couponError,
    loyaltyError,
    items,
  };
}
