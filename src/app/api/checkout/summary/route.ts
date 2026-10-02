/**
 * GET /api/checkout/summary?coupon=XYZ
 *
 * Returns the live totals for the user's cart, optionally with a coupon applied.
 * NEVER mutates anything. The same totals are recomputed at submit time.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { computeCheckoutTotals } from '@/lib/checkout/totals';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const coupon = req.nextUrl.searchParams.get('coupon');
  const redeem = Number(req.nextUrl.searchParams.get('redeem') ?? '0') || 0;
  // ?source=express → totals over the user's ExpressCheckout row (Buy-Now),
  // leaving the regular Cart table untouched. Default 'cart' for back-compat.
  const source = (req.nextUrl.searchParams.get('source') === 'express') ? 'express' as const : 'cart' as const;
  const [totals, cfg, addresses] = await Promise.all([
    computeCheckoutTotals(user, { couponCode: coupon, redeemPoints: redeem, source }),
    getStoreConfig(),
    // PAGINATION-EXEMPT: scoped to one user (same cap as /api/addresses).
    prisma.address.findMany({ where: { userId: user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  return jsonOk({
    source,
    totals,
    config: {
      paymentUpiId:    process.env.PAYMENT_UPI_ID ?? '',
      paymentDisplay:  process.env.PAYMENT_DISPLAY_NAME ?? cfg.store.name,
      maxReceiptMb:    cfg ? Number(process.env.MAX_UPLOAD_MB ?? 5) : 5,
      shipping: cfg.shipping,
      loyalty: { enabled: cfg.loyalty.enabled, redeemValuePaise: cfg.loyalty.redeemValuePaise },
    },
    addresses,
    user: {
      isB2B: user.role === 'B2B',
      gstin: user.gstin,
      loyaltyPoints: user.loyaltyPoints,
    },
  });
});
