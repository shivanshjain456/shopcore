/**
 * POST /api/auth/signup
 *
 * Creates a PENDING_OTP user, issues + emails a 6-digit OTP for SIGNUP.
 * Does NOT log the user in. They must POST to /api/auth/otp/verify next.
 *
 * Feature #11 — UNIQUENESS + POLICY ENFORCEMENT:
 *   - Duplicate email  → HTTP 409  "An account with this email address already exists."
 *   - Duplicate phone  → HTTP 409  "An account with this phone number already exists."
 *   - Weak/blocklisted password → HTTP 400 with the policy reason
 *   - Race-condition: even after our pre-checks, Prisma's P2002 from the
 *     `User.create` is caught and translated to the same 409 message
 *     (covers concurrent registrations).
 *
 * The PENDING_OTP "I never finished" path is preserved: if the *same* user
 * tries to re-signup with the same email AND their account is still
 * PENDING_OTP, we re-issue an OTP instead of saying "already exists" (that
 * would lock people out of completing their own signup). The privacy
 * trade-off is acceptable per the spec, which explicitly chooses the
 * clear UX message over the enumeration-mitigation pattern.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { SignupSchema } from '@/lib/auth/schemas';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordOk } from '@/lib/auth/passwordPolicy';
import { issueOtp } from '@/lib/auth/otp';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { env } from '@/lib/config';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

function isPrismaUniqueViolation(e: unknown): { target: string[] } | null {
  const err = e as { code?: string; meta?: { target?: string[] | string } } | undefined;
  if (err?.code !== 'P2002') return null;
  const t = err.meta?.target;
  return { target: Array.isArray(t) ? t : (typeof t === 'string' ? [t] : []) };
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  await applyRateLimit('auth.signup', req);

  // ── Item 8 — feature gates ─────────────────────────────────────────
  // Registration must be globally enabled AND not temporarily paused.
  // Both checks throw ForbiddenError with distinct codes
  // (FEATURE_DISABLED vs FEATURE_PAUSED) so the client can show
  // different copy.
  const { requireRegistrationOpen, requireRegistrationNotPaused } =
    await import('@/lib/storeConfig/featureGate');
  await requireRegistrationOpen();
  await requireRegistrationNotPaused();

  const body = await req.json();
  const input = SignupSchema.parse(body);
  // Second-pass policy check that has access to the parsed email so the
  // "password cannot contain your email name" rule fires correctly.
  try { assertPasswordOk(input.password, { email: input.email }); }
  catch (e) { return jsonError((e as Error).message, 400, { code: 'PASSWORD_POLICY' }); }

  const refCode = z.string().trim().min(1).max(80).optional().parse((body as { ref?: string }).ref ?? undefined);
  const referrer = refCode ? await prisma.user.findUnique({ where: { referralCode: refCode } }) : null;

  // ── Pre-check: same-email collision. Three sub-cases:
  //    ACTIVE      → 409 (per spec)
  //    PENDING_OTP → re-issue OTP (so the user can finish their own signup)
  //    SUSPENDED   → 409 (don't allow re-registration of a suspended email
  //                       without an admin un-suspending first)
  const existingByEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingByEmail) {
    if (existingByEmail.status === 'ACTIVE') {
      return jsonError('An account with this email address already exists.', 409, { code: 'EMAIL_TAKEN' });
    }
    if (existingByEmail.status === 'PENDING_OTP') {
      const r = await issueOtp({ email: input.email, purpose: 'SIGNUP', userId: existingByEmail.id, ipAddress: ip });
      if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });
      return jsonOk({
        message: 'Verification code sent. Please check your email.',
        email: input.email, otpLength: env.OTP_LENGTH, expiresAt: r.expiresAt,
      });
    }
    // SUSPENDED / DELETED → same 409. Admin can revive the account.
    return jsonError('An account with this email address already exists.', 409, { code: 'EMAIL_TAKEN' });
  }

  // ── Pre-check: same-phone collision. Always 409 (the PENDING_OTP grace
  //    path only applies to email — phone is the second identifier).
  const existingByPhone = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existingByPhone) {
    return jsonError('An account with this phone number already exists.', 409, { code: 'PHONE_TAKEN' });
  }

  // New user — hash & create. P2002 catch handles a race-condition
  // collision (two simultaneous registrations with the same email/phone).
  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        passwordHash,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        pinCode: input.pinCode,
        country: input.country,
        role: 'CUSTOMER',
        // STATE_MACHINE_BYPASS: initial-row insert. The Account State
        // Machine governs runtime TRANSITIONS between states; setting
        // the FIRST state of a brand-new row is the one legitimate
        // direct-write surface (there is no "from" to transition from).
        // From here on, the row's status moves only via
        // transitionAccountState (PENDING_OTP → ACTIVE happens in the
        // OTP-verify route).
        status: 'PENDING_OTP',
        referredById: referrer?.id ?? null,
      },
    });
  } catch (e) {
    const dup = isPrismaUniqueViolation(e);
    if (dup) {
      const onPhone = dup.target.some((t) => t.toLowerCase().includes('phone'));
      return jsonError(
        onPhone
          ? 'An account with this phone number already exists.'
          : 'An account with this email address already exists.',
        409,
        { code: onPhone ? 'PHONE_TAKEN' : 'EMAIL_TAKEN' },
      );
    }
    throw e;
  }

  // Also store the primary address as a saved Address row
  await prisma.address.create({
    data: {
      userId: user.id,
      label: 'Default',
      fullName: `${user.firstName} ${user.lastName}`,
      phone: user.phone,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      pinCode: user.pinCode,
      country: user.country,
      isDefault: true,
    },
  });

  await prisma.userActivity.create({
    data: { userId: user.id, action: 'SIGNUP', ipAddress: ip, metadata: JSON.stringify({ email: user.email }) },
  });

  const r = await issueOtp({ email: user.email, purpose: 'SIGNUP', userId: user.id, ipAddress: ip });
  if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });

  return jsonOk({
    message: 'Account created. Verification code sent to your email.',
    email: user.email,
    otpLength: env.OTP_LENGTH,
    expiresAt: r.expiresAt,
  });
});
