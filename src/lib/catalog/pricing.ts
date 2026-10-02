/**
 * Pricing helpers — tier-aware, paise-based, never returns floats.
 *
 * A user's effective price depends on:
 *   - Role: CUSTOMER → pricePaise; B2B → b2bPricePaise (fall back to pricePaise)
 *   - B2B tier discount: applied on top of b2bPricePaise
 *   - GST: stored on product; tax shown inclusive by default in India
 */
import type { Product, Variant, B2BTier, User } from '@prisma/client';

export interface PriceContext {
  isB2B: boolean;
  tier?: B2BTier | null;
}

export function priceCtxForUser(user: Pick<User, 'role'> | null, tier?: B2BTier | null): PriceContext {
  return { isB2B: user?.role === 'B2B', tier: user?.role === 'B2B' ? tier ?? null : null };
}

/** Compute the effective unit price in PAISE for a product or variant. */
export function effectivePricePaise(
  item: Pick<Product | Variant, 'pricePaise' | 'b2bPricePaise'>,
  ctx: PriceContext,
): number {
  let base = item.pricePaise;
  if (ctx.isB2B) {
    base = item.b2bPricePaise ?? item.pricePaise;
    if (ctx.tier && ctx.tier.discountPercent > 0) {
      const off = Math.round(base * (ctx.tier.discountPercent / 100));
      base = Math.max(0, base - off);
    }
  }
  return base;
}

/** MRP — same for everyone. Used to show strike-through. */
export function mrpPaise(item: Pick<Product | Variant, 'mrpPaise'>): number {
  return item.mrpPaise;
}

export function discountPercent(mrp: number, price: number): number {
  if (mrp <= 0 || price >= mrp) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}

export function rupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function rupeesDecimal(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
