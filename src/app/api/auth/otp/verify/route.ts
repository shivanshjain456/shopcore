/**
 * POST /api/auth/otp/verify
 * Body: { email, code, purpose }
 *
 * On success for SIGNUP / LOGIN: activates user (if needed), mirrors to Firebase,
 * issues a session cookie, returns the user summary.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { OtpVerifySchema } from '@/lib/auth/schemas';
import { verifyOtp } from '@/lib/auth/otp';
import { createSession } from '@/lib/auth/session';
import { mirrorUserToFirebase } from '@/lib/auth/firebase';
import { adjustLoyalty } from '@/lib/account/loyalty';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { isFeatureOn } from '@/lib/storeConfig/featureGate';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import type { UserRole } from '@/lib/enums';
import { transitionAccountState, UserStatus } from '@/lib/auth/accountStateMachine';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  // Per-IP cap on verify-route hits (the per-OTP attempt count is
  // enforced separately inside `verifyOtp`). Policy: auth.otp.verify.
  await applyRateLimit('auth.otp.verify', req);

  const { email, code, purpose } = OtpVerifySchema.parse(await req.json());

  const v = await verifyOtp({ email, code, purpose });
  if (!v.ok) {
    // log fail
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.userActivity.create({
        data: { userId: user.id, action: 'OTP_FAIL', ipAddress: ip, metadata: JSON.stringify({ purpose }) },
      });
    }
    return jsonError(v.reason, 400);
  }

  // Find the user
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return jsonError('Account not found. Please sign up.', 404);

  if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
    return jsonError('This account is not available. Please contact support.', 403);
  }

  // For SIGNUP: hop to PENDING_PHONE_VERIFICATION instead of ACTIVE.
  // Phone Verification feature — the user must still complete SMS-OTP
  // before reaching ACTIVE. SYSTEM-actor transition: the user proved
  // possession of their email via the OTP we just verified.
  //
  // For LOGIN / RESET / EMAIL_CHANGE on PENDING_OTP accounts, the
  // same hop applies (it's the FIRST verification step in the new
  // model — phone is the second).
  //
  // Item 8 — admin override: when `features.phoneVerificationRequired`
  // is OFF, we SKIP the phone-verification hop and transition straight
  // to ACTIVE. Audit + UserActivity captures the abbreviated path.
  // SECURITY: this is an admin-deliberate downgrade — phone OTP is a
  // strong account-takeover mitigation. The schema marks the flag
  // `dangerLevel: 'caution'` accordingly.
  //
  // The machine writes the UserActivity row for us.
  let postEmailVerifyTransitioned = false;
  if (user.status === 'PENDING_OTP') {
    const phoneRequired = await isFeatureOn('features.phoneVerificationRequired');
    const nextStatus = phoneRequired
      ? UserStatus.PENDING_PHONE_VERIFICATION
      : UserStatus.ACTIVE;
    const r = await transitionAccountState(
      user.id,
      nextStatus,
      { type: 'SYSTEM' },
      { reason: phoneRequired
          ? `OTP ${purpose} verified — email step complete`
          : `OTP ${purpose} verified — admin disabled phone verification` },
    );
    if (!r.ok) {
      // Shouldn't happen — PENDING_OTP → PENDING_PHONE_VERIFICATION is
      // unconditionally allowed for SYSTEM — defence-in-depth log.
      return jsonError('Could not advance the account. Please try again.', 500, { code: r.reason });
    }
    postEmailVerifyTransitioned = true;
    // Mirror to Firebase (no-op if not configured). Email-mirror is
    // independent of phone verification and runs at this point so the
    // user record exists in Firebase before they hit `/verify-phone`.
    const uid = await mirrorUserToFirebase({
      id: user.id, email: user.email,
      firstName: user.firstName, lastName: user.lastName, phone: user.phone,
    });
    if (uid && uid !== user.firebaseUid) {
      await prisma.user.update({ where: { id: user.id }, data: { firebaseUid: uid } });
    }

    // Signup bonus + referral bonuses still credit here — they are
    // gated on a successful EMAIL verification, not phone. (Reverting
    // these on failed phone-verify would be observer-visible and
    // pointless: an abandoned account just sits with the points but
    // can never spend them since orders require ACTIVE.)
    const cfg = await getStoreConfig();
    // Item 8: master loyalty + referral toggles override the legacy
    // `loyalty.enabled` flag. Both must be ON for points to be credited.
    const loyaltyMaster = cfg.features.loyaltyEnabled;
    const referralMaster = cfg.features.referralEnabled;
    if (cfg.loyalty.enabled && loyaltyMaster) {
      await prisma.$transaction(async (tx) => {
        const had = await tx.loyaltyLedger.findFirst({ where: { userId: user.id, reason: 'SIGNUP_BONUS' } });
        if (!had && cfg.loyalty.signupBonus > 0) {
          await adjustLoyalty(tx, user.id, cfg.loyalty.signupBonus, 'SIGNUP_BONUS');
        }
        if (user.referredById && referralMaster) {
          const hadRef = await tx.loyaltyLedger.findFirst({ where: { userId: user.id, reason: 'REFERRAL_REFEREE' } });
          if (!hadRef) {
            if (cfg.loyalty.refereeBonus > 0)  await adjustLoyalty(tx, user.id,            cfg.loyalty.refereeBonus,  'REFERRAL_REFEREE',  user.referredById);
            if (cfg.loyalty.referrerBonus > 0) await adjustLoyalty(tx, user.referredById!, cfg.loyalty.referrerBonus, 'REFERRAL_REFERRER', user.id);
          }
        }
      });
    }
  }

  await prisma.userActivity.create({
    data: { userId: user.id, action: 'OTP_VERIFIED', ipAddress: ip, metadata: JSON.stringify({ purpose }) },
  });

  // For SIGNUP and LOGIN we create a session. For RESET we don't (caller goes to set-new-password).
  if (purpose === 'SIGNUP' || purpose === 'LOGIN') {
    await createSession({ id: user.id, role: user.role as UserRole, email: user.email });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  }

  // Decide nextStep. After this email-OTP success:
  //   - If the user just hopped PENDING_OTP → PENDING_PHONE_VERIFICATION
  //     (signup flow), the next required step is the phone OTP.
  //   - Admins skip the phone step (their flow is internal — see admin
  //     login path which sets ACTIVE directly via bootstrap / Excel).
  //   - For RESET / EMAIL_CHANGE on a user that was already ACTIVE,
  //     nothing more is required.
  const needsPhoneStep =
    postEmailVerifyTransitioned
    && user.role !== 'ADMIN'
    && (purpose === 'SIGNUP' || purpose === 'LOGIN');
  const next = needsPhoneStep
    ? '/verify-phone?from=registration'
    : user.role === 'ADMIN' ? '/admin'
    : user.role === 'B2B' ? '/b2b/dashboard'
    : '/account';

  return jsonOk({
    message: 'Verified.',
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
    next,
    ...(needsPhoneStep ? {
      nextStep: 'PHONE_VERIFICATION' as const,
      redirectTo: '/verify-phone?from=registration',
    } : {}),
  });
});
