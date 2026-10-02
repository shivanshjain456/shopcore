/**
 * POST /api/auth/forgot-password/initiate
 *
 * Body: { email }
 *
 * Always returns 200 with a generic envelope — never reveals whether the
 * email is registered. The OTP send is fire-and-forget so the response is
 * NOT delayed by SMTP latency (matches spec: "Email delivery must be
 * asynchronous and must not block the API response").
 *
 * Response: { ok:true, data: { requestId, expiresAt, message } }
 *
 *   - requestId       — client echoes this on /verify-otp and /resend
 *                       (may be a synthesised `noop_*` if the email is
 *                       unknown — the route does not differentiate)
 *   - expiresAt       — when the whole reset request expires (30 min)
 *   - message         — generic, identical for known and unknown emails
 *
 * Rate limits:
 *   - 5 / hour / IP
 *   - 3 / hour / (IP + email)  ← per-email throttle on top of the IP one
 *
 * The 60s OTP resend cooldown is enforced inside `issueOtp` (re-used).
 */
import type { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit, checkRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { ForgotPasswordInitiateSchema } from '@/lib/auth/schemas';
import { initiateReset, RESET_INITIATE_MESSAGE } from '@/lib/auth/passwordReset';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  // Per-IP HARD cap — throws RateLimitError → 429.
  await applyRateLimit('auth.forgot_password.initiate', req);

  const { email } = ForgotPasswordInitiateSchema.parse(await req.json().catch(() => ({})));

  // Per-(IP+email) SOFT cap — must NOT throw, because a 429 here would
  // tell an attacker which (ip, email) pairs are being throttled,
  // which is itself an enumeration signal. Instead we always return
  // the generic noop_throttled envelope so the response is
  // indistinguishable from a normal initiate for an unknown email.
  const rlIpEmail = await checkRateLimit('auth.forgot_password.per_email', req, { email });
  if (!rlIpEmail.ok) {
    log.info('passwordReset.initiate.throttled', { email });
    return jsonOk({
      requestId: 'noop_throttled',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      message: RESET_INITIATE_MESSAGE,
    });
  }

  const ua = headers().get('user-agent') ?? null;

  // Fire the underlying flow. For unknown emails this returns a
  // synthesised requestId without persisting anything.
  const r = await initiateReset({ email, ipAddress: ip, userAgent: ua });

  return jsonOk({
    requestId: r.requestId,
    expiresAt: r.expiresAt.toISOString(),
    message: RESET_INITIATE_MESSAGE,
  });
});
