/**
 * POST /api/auth/admin/login
 *
 * Same two-step flow as customer login, but:
 *   - only accepts users with role=ADMIN
 *   - issues the sc_admin cookie (separate from sc_session) on OTP verify
 *   - tighter rate limit (3 per 15 min per IP)
 *
 * The page that calls this lives at /admin/login (intentionally unlinked from
 * the public navigation).
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { AdminLoginSchema } from '@/lib/auth/schemas';
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

  await applyRateLimit('auth.admin.login', req);

  const { email, password } = AdminLoginSchema.parse(await req.json());

  const user = await prisma.user.findUnique({ where: { email } });
  const dummy = '$2a$12$abcdefghijklmnopqrstuvCgB6jHkDxJpfTQ8FQ4VqV3kQ3oqWXqaq';
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, dummy), false);

  if (!user || !ok || user.role !== 'ADMIN') {
    if (user) {
      await prisma.userActivity.create({
        data: { userId: user.id, action: 'ADMIN_LOGIN_FAIL', ipAddress: ip, metadata: JSON.stringify({ ip }) },
      });
    }
    return jsonError('Invalid email or password.', 401);
  }

  if (user.status !== 'ACTIVE' && user.status !== 'PENDING_OTP') {
    return jsonError('Admin account is not available.', 403);
  }

  const r = await issueOtp({ email, purpose: 'LOGIN', userId: user.id, ipAddress: ip });
  if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });

  return jsonOk({
    message: 'Password verified. An admin login code has been sent.',
    email, purpose: 'LOGIN',
    otpLength: env.OTP_LENGTH, expiresAt: r.expiresAt,
  });
});
