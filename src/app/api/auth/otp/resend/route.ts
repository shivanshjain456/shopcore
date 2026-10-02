/**
 * POST /api/auth/otp/resend
 * Body: { email, purpose }
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { OtpResendSchema } from '@/lib/auth/schemas';
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
  await applyRateLimit('auth.otp.resend', req);

  const { email, purpose } = OtpResendSchema.parse(await req.json());
  const user = await prisma.user.findUnique({ where: { email } });

  // Don't reveal whether the account exists.
  if (!user) return jsonOk({ message: 'If the email exists, a code has been sent.' });

  const r = await issueOtp({ email, purpose, userId: user.id, ipAddress: ip });
  if (!r.ok) return jsonError(r.reason, 429, { retryAfterSeconds: r.retryAfterSeconds });

  return jsonOk({
    message: 'Verification code sent.',
    otpLength: env.OTP_LENGTH,
    expiresAt: r.expiresAt,
  });
});
