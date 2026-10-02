/**
 * POST /api/auth/forgot-password/resend
 *
 * Body: { requestId }
 *
 * Re-issues an OTP for an active reset request. Invalidates any prior
 * un-verified OTP for the same request (cascade through issueOtp's
 * existing behaviour). Enforces:
 *
 *   - 60s cooldown per email (inherited from issueOtp)
 *   - maxOtpIssue cap on the request itself (5 by default)
 *   - per-IP per-hour rate limit
 *
 * Always returns generic shape — no enumeration via response timing.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { env } from '@/lib/config';
import { ForgotPasswordResendSchema } from '@/lib/auth/schemas';
import { resendResetOtp } from '@/lib/auth/passwordReset';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  await applyRateLimit('auth.forgot_password.resend', req);

  const { requestId } = ForgotPasswordResendSchema.parse(await req.json().catch(() => ({})));
  const r = await resendResetOtp({ requestId, ipAddress: ip });
  if (!r.ok) {
    return jsonError(r.reason, r.status ?? 429, { retryAfterSeconds: r.retryAfterSeconds });
  }
  return jsonOk({
    message: 'A new code has been sent.',
    expiresAt: r.expiresAt.toISOString(),
  });
});
