/**
 * Coupon evaluation. Returns the discount in paise + the (still-untouched) Coupon row
 * so the caller can attach it to the order and increment usedCount inside their tx.
 */
import type { Prisma, Coupon } from '@prisma/client';

export interface CouponEvalInput {
  code: string;
  subtotalPaise: number;
  isB2B: boolean;
  userId: string;
  now?: Date;
}

export interface CouponEvalOk {
  ok: true;
  coupon: Coupon;
  discountPaise: number;
  freeShipping: boolean;
}
export interface CouponEvalErr { ok: false; reason: string; }

export async function evaluateCoupon(
  tx: Prisma.TransactionClient,
  input: CouponEvalInput,
): Promise<CouponEvalOk | CouponEvalErr> {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();
  if (!code) return { ok: false, reason: 'Empty coupon code.' };

  const coupon = await tx.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) return { ok: false, reason: 'Invalid coupon.' };
  if (coupon.validFrom > now) return { ok: false, reason: 'Coupon is not yet active.' };
  if (coupon.validUntil < now) return { ok: false, reason: 'Coupon has expired.' };
  if (input.isB2B && !coupon.appliesToB2B) return { ok: false, reason: 'Coupon not valid for B2B orders.' };
  if (!input.isB2B && !coupon.appliesToB2C) return { ok: false, reason: 'Coupon not valid for B2C orders.' };
  if (coupon.minOrderPaise > 0 && input.subtotalPaise < coupon.minOrderPaise) {
    return { ok: false, reason: `Minimum order ₹${coupon.minOrderPaise / 100} required.` };
  }
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: 'Coupon usage limit reached.' };
  }
  if (coupon.perUserLimit != null) {
    const usedByUser = await tx.order.count({
      where: { couponId: coupon.id, userId: input.userId },
    });
    if (usedByUser >= coupon.perUserLimit) {
      return { ok: false, reason: 'You have already used this coupon.' };
    }
  }

  let discount = 0;
  let freeShipping = false;
  switch (coupon.discountType) {
    case 'PERCENT': {
      discount = Math.round(input.subtotalPaise * (coupon.value / 100));
      if (coupon.maxDiscountPaise != null && discount > coupon.maxDiscountPaise) {
        discount = coupon.maxDiscountPaise;
      }
      break;
    }
    case 'FLAT': {
      discount = Math.min(coupon.value, input.subtotalPaise);
      break;
    }
    case 'FREE_SHIPPING': {
      freeShipping = true;
      break;
    }
    default:
      return { ok: false, reason: 'Unsupported coupon type.' };
  }

  return { ok: true, coupon, discountPaise: discount, freeShipping };
}
