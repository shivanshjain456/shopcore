/**
 * POST /api/auth/login
 *
 * Step 1 of two-step login: verify email + password, then issue + email a LOGIN OTP.
 * Client must then call /api/auth/otp/verify with purpose=LOGIN to receive a session.
 *
 * This means every login requires possession of the email inbox — strong security.
 *
 * Refuses ADMIN logins (admins must use /api/auth/admin/login).
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { LoginSchema } from '@/lib/auth/schemas';
import { verifyPassword } from '@/lib/auth/password';
import { issueOtp } from '@/lib/auth/otp';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  // Per-IP brute-force protection — `auth.login` policy.
  await applyRateLimit('auth.login', req);

  const { email, password } = LoginSchema.parse(await req.json());

  // Per-email cap — `auth.login.email` policy. Protects a single
  // account from a distributed brute force across many IPs.
  await applyRateLimit('auth.login.email', req, { email });

  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-ish-time response: do a dummy verify so timing doesn't leak existence
  const dummy = '$2a$12$abcdefghijklmnopqrstuvCgB6jHkDxJpfTQ8FQ4VqV3kQ3oqWXqaq';
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, dummy), false);

  if (!user || !ok) {
    if (user) {
      await prisma.userActivity.create({
        data: { userId: user.id, action: 'LOGIN_FAIL', ipAddress: ip, metadata: JSON.stringify({ reason: 'bad-credentials' }) },
      });
    }
    return jsonError('Invalid email or password.', 401);
  }

  if (user.role === 'ADMIN') {
    // Admins must use the dedicated admin endpoint
    return jsonError('Use the admin login page.', 403);
  }

  if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
    return jsonError('This account is not available. Please contact support.', 403);
  }

  if (user.status === 'PENDING_OTP') {
    // First-time activation flow — still needs OTP
    const r = await issueOtp({ email, purpose: 'SIGNUP', userId: user.id, ipAddress: ip });
    if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });
    return jsonOk({
      message: 'Account requires email verification. Code sent.',
      email, purpose: 'SIGNUP',
      otpLength: env.OTP_LENGTH, expiresAt: r.expiresAt,
    });
  }

  // Issue LOGIN OTP
  const r = await issueOtp({ email, purpose: 'LOGIN', userId: user.id, ipAddress: ip });
  if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });

  return jsonOk({
    message: 'Password verified. A login code has been sent to your email.',
    email, purpose: 'LOGIN',
    otpLength: env.OTP_LENGTH, expiresAt: r.expiresAt,
  });
});
