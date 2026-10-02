/**
 * POST  /api/checkout/express   — create / upsert a Buy-Now session
 * DELETE /api/checkout/express  — abandon the current Buy-Now session
 *
 * The POST body carries only { productId, variantId?, quantity }. Pricing,
 * stock, and active-flag validation all happen server-side. On success we
 * set the `sc_express` HttpOnly cookie and return `{ ok:true, id, expiresAt }`;
 * the client immediately redirects to /checkout?express=1 which the
 * checkout summary endpoint (`/api/checkout/summary?source=express`) reads
 * and totals from the express row instead of the user's Cart.
 *
 * Rapid clicks → upsert by userId → same row, no duplicate session.
 * Concurrent stock storm → same Bug #5 validation as `addToCart()`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { isOrderPermitted } from '@/lib/auth/accountStateMachine';
import {
  requireCheckoutNotPaused,
  requireUpiEnabled,
} from '@/lib/storeConfig/featureGate';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { prisma } from '@/lib/db/client';
import {
  upsertExpressCheckout, setExpressCookie, clearExpressCookie, EXPRESS_COOKIE,
} from '@/lib/checkout/express';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

const Body = z.object({
  productId: z.string().min(1),
  variantId: z.string().nullable().optional(),
  // Per-line cap = B2B max; upsertExpressCheckout re-clamps to B2C for non-B2B.
  quantity:  z.number().int().min(1).max(500).default(1),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();

  // Item 8: pause + payment-method gates apply to Buy Now as well.
  await requireCheckoutNotPaused();
  await requireUpiEnabled();

  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in to continue.', 401);

  // Same account-state gate as /api/checkout/place-order — Buy Now is
  // a checkout precursor, not a free-tier action.
  if (!isOrderPermitted(user.status)) {
    return jsonError(
      'Your account is not eligible to place orders. Please complete verification or contact support.',
      403,
      { code: 'ACCOUNT_NOT_ORDER_PERMITTED', status: user.status },
    );
  }

  // Cheap brute-force guard — rapid clicks already collapse on the
  // upsert but a hostile script shouldn't hammer the validator.
  await applyRateLimit('checkout.express', req, { userId: user.id });

  const body = Body.parse(await req.json());
  const r = await upsertExpressCheckout({
    userId: user.id,
    productId: body.productId,
    variantId: body.variantId ?? null,
    quantity: body.quantity,
  });
  if (!r.ok) {
    // *_NOT_FOUND → 404; everything else (inactive / OOS / insufficient
    // / invalid qty) → 400, matching the cart endpoint vocabulary so the
    // PDP error UI can reuse the same handlers.
    const status = r.code === 'PRODUCT_NOT_FOUND' || r.code === 'VARIANT_NOT_FOUND' ? 404 : 400;
    return jsonError(r.reason, status, { code: r.code, ...(r.details ?? {}) });
  }

  setExpressCookie(r.id, r.expiresAt);
  return jsonOk({
    id: r.id, expiresAt: r.expiresAt.toISOString(),
    redirect: '/checkout?express=1',
  });
});

export const DELETE = withErrorHandling(async (_req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  // Best-effort: delete the user's express row + clear the cookie.
  const cookieId = cookies().get(EXPRESS_COOKIE)?.value ?? null;
  if (cookieId) {
    await prisma.expressCheckout.deleteMany({ where: { id: cookieId, userId: user.id } });
  } else {
    await prisma.expressCheckout.deleteMany({ where: { userId: user.id } });
  }
  clearExpressCookie();
  return jsonOk({ cleared: true });
});
