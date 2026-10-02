/**
 * POST /api/checkout/place-order
 *
 * ── PRICE-INTEGRITY CONTRACT ──────────────────────────────────────────────
 * The request body MUST NOT carry any price, total, line-item, tax, shipping,
 * or discount field. The server independently re-derives every monetary value
 * from the authoritative database state. See `lib/checkout/placeOrder.ts`.
 * Forbidden-field trip-wire (below) returns HTTP 400 if any are present.
 *
 * ── IDEMPOTENCY CONTRACT ──────────────────────────────────────────────────
 * Every POST MUST carry an `Idempotency-Key` header (UUID or opaque token,
 * 16–128 chars of [A-Za-z0-9_.:-]). The server uses it to deduplicate
 * retries / double-clicks / concurrent submissions:
 *
 *   - First request with a (userId, key) pair runs the operation.
 *   - Subsequent requests with the SAME (userId, key) AND the SAME request
 *     payload get the SAME response (same status, same body, same orderId)
 *     without re-executing the work.
 *   - Reusing the key with a DIFFERENT payload returns 409 Conflict.
 *   - Concurrent requests with the same key serialise on the DB unique
 *     constraint; only one creates an order.
 *
 * Implementation: `lib/checkout/idempotency.ts` (`withIdempotency()`).
 * Regression suite: `scripts/test-idempotency.ts`.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonError, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { isOrderPermitted } from '@/lib/auth/accountStateMachine';
import { placeOrder } from '@/lib/checkout/placeOrder';
import {
  requireCheckoutNotPaused,
  requireUpiEnabled,
} from '@/lib/storeConfig/featureGate';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { log } from '@/lib/log';
import {
  IDEMPOTENCY_HEADER, asIdempotencyKeyHeader, fingerprintRequest, withIdempotency,
} from '@/lib/checkout/idempotency';

export const dynamic = 'force-dynamic';

const Body = z.object({
  shippingAddressId: z.string().min(1),
  billingAddressId:  z.string().min(1).optional().nullable(),
  couponCode:        z.string().trim().max(40).optional().nullable(),
  redeemPoints:      z.number().int().min(0).max(1_000_000).optional().nullable(),
  // Payment method declares which UTR format we should validate against.
  // Defaults to UPI for back-compat with checkout clients that haven't yet
  // upgraded; the server still runs full sanitisation + fraud checks.
  paymentMethod:     z.enum(['UPI', 'IMPS', 'NEFT', 'RTGS']).optional().default('UPI'),
  // Wire-level shape: lenient on length here (helpers re-validate per method).
  // We KEEP a hard upper bound so a hostile client can't ship 10 MB of "X"s.
  utrNumber:         z.string().min(1).max(64),
  receiptUrl:        z.string().startsWith('/api/uploads/'),
  customerNote:      z.string().trim().max(500).optional().nullable(),
  gstinAtOrder:      z.string().trim().max(15).optional().nullable(),
  // Feature — Buy Now: 'express' tells placeOrder() to use the user's
  // ExpressCheckout row instead of the Cart table. Defaults to 'cart'.
  source:            z.enum(['cart', 'express']).optional().default('cart'),
}).strict();

type PlaceOrderOk  = { ok: true;  data:  { orderId: string; orderNumber: string; totalPaise: number } };
type PlaceOrderErr = { ok: false; error: string;  offenders?: string[]; code?: string };
type PlaceOrderRes = PlaceOrderOk | PlaceOrderErr;

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();

  // Item 8 — checkout-level feature gates.
  //   1. `maintenance.checkoutPaused` → 403 FEATURE_PAUSED.
  //   2. `payments.upiEnabled`        → 403 FEATURE_DISABLED.
  // Both fire BEFORE auth so a paused checkout returns the same error
  // shape to anonymous and authenticated callers.
  await requireCheckoutNotPaused();
  await requireUpiEnabled();

  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);

  // Account-state gate: only fully-ACTIVE accounts can place orders.
  // `getCurrentUser()` already accepts PENDING_PHONE_VERIFICATION as a
  // login-permitted state (so the user can resume verification), but
  // placing an order is a stronger requirement. Without this check, a
  // user whose JWT still says PENDING_PHONE_VERIFICATION or whose
  // status flipped to SUSPENDED in the last 14.5 min (within JWT TTL)
  // could complete a checkout.
  if (!isOrderPermitted(user.status)) {
    return jsonError(
      'Your account is not eligible to place orders. Please complete verification or contact support.',
      403,
      { code: 'ACCOUNT_NOT_ORDER_PERMITTED', status: user.status },
    );
  }

  await applyRateLimit('checkout.place_order', req, { userId: user.id });

  const raw = await req.json().catch(() => ({} as Record<string, unknown>));

  // Price-tamper trip-wire (see PRICE-INTEGRITY CONTRACT)
  const FORBIDDEN_KEYS = [
    'price', 'unitprice', 'unitpricepaise', 'total', 'totalamount', 'totalpaise',
    'grandtotal', 'subtotal', 'subtotalpaise', 'discount', 'discountpaise',
    'shipping', 'shippingpaise', 'tax', 'taxpaise', 'amount', 'items', 'lineitems',
  ];
  const offenders: string[] = [];
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) offenders.push(k);
    }
  }
  if (offenders.length > 0) {
    log.warn('checkout.price_tamper_attempt', { userId: user.id, ip: clientIp(), offenders });
    return jsonError(
      `Pricing fields are computed server-side; do not send them. Forbidden: ${offenders.join(', ')}`,
      400,
      { offenders },
    );
  }

  const body = Body.parse(raw);

  // Idempotency: a missing key is a hard error in production-grade flows.
  const key = asIdempotencyKeyHeader(req.headers);
  if (!key) {
    return jsonError(
      `Missing ${IDEMPOTENCY_HEADER} header. Generate a UUID and resend it on every retry.`,
      400,
    );
  }
  // Fingerprint binds (user, request body) — different payload + same key = 409
  const fingerprint = fingerprintRequest({ userId: user.id, body });

  const outcome = await withIdempotency<PlaceOrderRes>({
    userId: user.id,
    key,
    endpoint: 'POST /api/checkout/place-order',
    fingerprint,
    work: async () => {
      const r = await placeOrder({
        user, ...body,
        clientIp:  clientIp(),
        userAgent: req.headers.get('user-agent'),
      });
      if (!r.ok) {
        // UTR-duplicate fraud attempts get HTTP 409 so monitoring can spot
        // them; everything else stays 400 to match existing client behaviour.
        const status = r.code === 'DUPLICATE' ? 409 : 400;
        return { status, body: { ok: false, error: r.reason, code: r.code }, orderId: null };
      }
      return {
        status: 200,
        body: { ok: true, data: { orderId: r.orderId, orderNumber: r.orderNumber, totalPaise: r.totalPaise } },
        orderId: r.orderId,
      };
    },
  });

  switch (outcome.kind) {
    case 'malformed':
      return jsonError(outcome.reason, 400);
    case 'conflict':
      return jsonError(outcome.reason, 409);
    case 'fresh': {
      const res = NextResponse.json(outcome.body, { status: outcome.status });
      res.headers.set('Idempotency-Status', 'created');
      if (body.source === 'express' && outcome.status === 200) clearExpressOnRes(res);
      return res;
    }
    case 'replay': {
      const res = NextResponse.json(outcome.body, { status: outcome.status });
      res.headers.set('Idempotency-Status', 'replayed');
      if (outcome.orderId) res.headers.set('X-Order-Id', outcome.orderId);
      if (body.source === 'express' && outcome.status === 200) clearExpressOnRes(res);
      return res;
    }
  }
});

/** Clear the express cookie on the response — only invoked when the
 *  source was 'express' AND the order placement actually succeeded. */
function clearExpressOnRes(res: NextResponse): void {
  res.headers.append(
    'Set-Cookie',
    'sc_express=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
  );
}


