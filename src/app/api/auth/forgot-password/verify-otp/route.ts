/**
 * POST /api/auth/forgot-password/verify-otp
 *
 * Body: { requestId, code }
 *
 * On success returns { resetToken, expiresAt } — the resetToken is the
 * plaintext 256-bit secret, single-use, ~10 min TTL. The client uses it on
 * /reset to set the new password. The plaintext is never logged.
 *
 * On failure returns the same generic-shaped message verifyOtp emits. The
 * underlying OtpCode row is bound to the request via OtpCode.resetRequestId
 * so a stolen OTP can't be paired with a different requestId.
 *
 * Rate limits:
 *   - 30 / 10-min / IP   ← hard ceiling on brute-force across all requests
 *   - per-OTP attempt counter (5) inside verifyOtp() — last attempt
 *     auto-consumes the OTP, forcing a resend
 */
import type { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { ForgotPasswordVerifyOtpSchema } from '@/lib/auth/schemas';
import { verifyResetOtp } from '@/lib/auth/passwordReset';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();
  const ua = headers().get('user-agent') ?? null;

  await applyRateLimit('auth.forgot_password.verify', req);

  const { requestId, code } = ForgotPasswordVerifyOtpSchema.parse(await req.json().catch(() => ({})));

  const v = await verifyResetOtp({ requestId, code, ipAddress: ip, userAgent: ua });
  if (!v.ok) {
    return jsonError(v.reason, v.status ?? 400, { code: v.code });
  }

  // Plaintext token returned ONCE. Never logged.
  return jsonOk({
    resetToken: v.resetToken,
    expiresAt:  v.expiresAt.toISOString(),
  });
});
