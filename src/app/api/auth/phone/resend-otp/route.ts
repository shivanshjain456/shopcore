/**
 * POST /api/auth/phone/resend-otp
 *
 * Server-side gate before the client re-triggers Firebase's
 * `signInWithPhoneNumber`. This route does NOT itself send SMS — that's
 * Firebase's job — but it rate-limits the client's ability to ask for
 * another code and confirms that the phone-on-file matches the one the
 * client is about to feed Firebase.
 *
 * Auth: session in PENDING_PHONE_VERIFICATION or ACTIVE.
 * CSRF: required.
 * Rate-limit: 3 requests / hour / IP.
 */
import { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/log';
import { PhoneResendBodySchema } from '@/lib/auth/schemas';
import { normalisePhone } from '@/lib/auth/phoneVerification';
import { UserStatus } from '@/lib/enums';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  await applyRateLimit('auth.phone.resend', req);

  const user = await getCurrentUser();
  if (!user) return jsonError('Authentication required.', 401);

  if (user.status !== UserStatus.PENDING_PHONE_VERIFICATION
   && user.status !== UserStatus.ACTIVE) {
    return jsonError('Your account is not in a state that permits phone verification.', 400,
      { code: 'INVALID_STATE' });
  }

  const { phone } = PhoneResendBodySchema.parse(await req.json());
  const submitted = normalisePhone(phone);
  const onFile    = normalisePhone(user.phone);
  if (!submitted || !onFile || submitted !== onFile) {
    return jsonError('The phone number does not match the one on your account.', 400,
      { code: 'PHONE_MISMATCH' });
  }

  log.info('phone.resend_otp.allowed', { userId: user.id });
  return jsonOk({ canProceed: true });
});
