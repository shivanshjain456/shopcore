/**
 * POST /api/auth/phone/verify
 *
 * Body:  { idToken: string, phone: string }
 *
 * Verifies the Firebase phone-auth ID token, cross-checks the three
 * phone-number sources (DB / submitted / token claim), updates the
 * verification columns, and (if applicable) transitions the account
 * PENDING_PHONE_VERIFICATION → ACTIVE.
 *
 * Auth: session required, in state PENDING_PHONE_VERIFICATION OR ACTIVE
 *       (the latter so retries are idempotent).
 * CSRF: required.
 * Rate-limit: 5/15min/IP + 3/hour/userId (per spec).
 *
 * Dev-bypass: `idToken === 'dev-bypass-token'` accepted ONLY when
 * NODE_ENV !== 'production'. Triple-guarded (this route + service +
 * preflight).
 */
import { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { getCurrentUser, reissueAccessTokenForCurrentRequest } from '@/lib/auth/session';
import { env } from '@/lib/config';
import { log } from '@/lib/log';
import {
  verifyPhoneCredential,
  type PhoneVerifyFailureReason,
  maskPhone,
} from '@/lib/auth/phoneVerification';
import { DEV_BYPASS_TOKEN } from '@/lib/auth/phoneConstants';
import { PhoneVerifyBodySchema } from '@/lib/auth/schemas';

export const dynamic = 'force-dynamic';

function reasonToStatus(reason: PhoneVerifyFailureReason): number {
  switch (reason) {
    case 'INVALID_FIREBASE_TOKEN':   return 401;
    case 'PHONE_MISMATCH':           return 400;
    case 'PHONE_TAKEN':              return 409;
    case 'PHONE_ALREADY_LINKED':     return 409;
    case 'INVALID_STATE':            return 400;
    case 'DEV_BYPASS_REJECTED':      return 400;
    case 'FIREBASE_UNAVAILABLE':     return 503;
    case 'USER_NOT_FOUND':           return 404;
    case 'STATE_MACHINE_REJECTED':   return 409;
  }
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  // Authenticate first so the user id is available for the compound
  // `ip+userId` rate-limit policy below.
  const user = await getCurrentUser();
  if (!user) return jsonError('Authentication required.', 401);

  // Policy `auth.phone.verify` — IP and userId windows checked together
  // (burst 5/15min + sustained 3/hr/user).
  await applyRateLimit('auth.phone.verify', req, { userId: user.id });

  const body = PhoneVerifyBodySchema.parse(await req.json());

  // TRIPLE-GUARD point #1 — reject dev-bypass token in production
  // BEFORE we even reach the service. The service has its own copy
  // of this check; preflight is the third copy.
  if (body.idToken === DEV_BYPASS_TOKEN && env.NODE_ENV === 'production') {
    log.warn('phone.verify.dev_bypass', { userId: user.id, rejected: true, reason: 'production_guard' });
    return jsonError('Verification failed.', 400, { code: 'DEV_BYPASS_REJECTED' });
  }

  log.info('phone.verify.initiated', { userId: user.id, phone: maskPhone(body.phone) });

  const r = await verifyPhoneCredential(user.id, body.idToken, body.phone);

  if (!r.ok) {
    return jsonError(
      humanMessage(r.reason, r.detail),
      reasonToStatus(r.reason),
      { code: r.reason, ...(r.detail ? { detail: r.detail } : {}) },
    );
  }
  // Re-issue the access-token cookie so the next request's middleware
  // reads the FRESH `status` claim (ACTIVE, not PENDING_PHONE_VERIFICATION).
  // Without this, /account would keep redirecting to /verify-phone for
  // the next ~15 min (until access-token TTL expires).
  await reissueAccessTokenForCurrentRequest();
  return jsonOk({
    phoneVerified: true,
    accountStatus: r.data.accountStatus,
    alreadyVerified: r.data.alreadyVerified,
  });
});

// (Body shape lives in `@/lib/auth/schemas.ts` as `PhoneVerifyBodySchema`,
// which uses the canonical `phoneSchema` so every entry point shares the
// same Item-9 normalisation contract. Item 9 retired the dev-time shape
// stub that was here.)

function humanMessage(reason: PhoneVerifyFailureReason, detail?: string): string {
  switch (reason) {
    case 'INVALID_FIREBASE_TOKEN': return 'Could not verify your phone code. Please request a fresh code and try again.';
    case 'PHONE_MISMATCH':         return 'The phone number does not match the one on your account.';
    case 'PHONE_TAKEN':            return 'This phone number is already verified on another account.';
    case 'PHONE_ALREADY_LINKED':   return 'This account is linked to a different Firebase phone identity.';
    case 'INVALID_STATE':          return 'Your account is not in a state that permits phone verification.';
    case 'DEV_BYPASS_REJECTED':    return 'Verification failed.';
    case 'FIREBASE_UNAVAILABLE':   return 'Phone verification is temporarily unavailable. Please try again shortly.';
    case 'USER_NOT_FOUND':         return 'Account not found.';
    case 'STATE_MACHINE_REJECTED': return detail ?? 'Could not update your account state. Please try again.';
  }
}
