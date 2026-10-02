/**
 * PATCH /api/account/phone
 *
 * Body: { phone: string }
 *
 * Lets a user update their phone number. The new number is unverified,
 * so we transition the account ACTIVE → PENDING_PHONE_VERIFICATION and
 * revoke every refresh family so the user is logged out and forced to
 * re-login with the fresh `status` claim in their JWT.
 *
 * Auth: session in ACTIVE state (a user mid-phone-verification can't
 *       use this surface — they should complete the existing flow).
 * CSRF: required.
 * Rate-limit: 3/hour/userId — phone changes should be rare.
 */
import { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { getCurrentUser } from '@/lib/auth/session';
import { UserStatus } from '@/lib/enums';
import { UpdatePhoneBodySchema } from '@/lib/auth/schemas';
import {
  updateUserPhone,
  type UpdatePhoneFailureReason,
} from '@/lib/auth/phoneVerification';

export const dynamic = 'force-dynamic';

function reasonToStatus(reason: UpdatePhoneFailureReason): number {
  switch (reason) {
    case 'INVALID_PHONE':          return 400;
    case 'PHONE_TAKEN':            return 409;
    case 'USER_NOT_FOUND':         return 404;
    case 'STATE_MACHINE_REJECTED': return 409;
  }
}

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Authentication required.', 401);

  if (user.status !== UserStatus.ACTIVE) {
    return jsonError('Your account is not in a state that permits this change.', 400,
      { code: 'INVALID_STATE' });
  }

  await applyRateLimit('account.phone_update', req, { userId: user.id });

  const { phone } = UpdatePhoneBodySchema.parse(await req.json());

  const r = await updateUserPhone(user.id, phone);
  if (!r.ok) {
    return jsonError(
      r.detail ?? humanMessage(r.reason),
      reasonToStatus(r.reason),
      { code: r.reason },
    );
  }
  return jsonOk({ phone: r.data.phone, requiresVerification: true });
});

function humanMessage(reason: UpdatePhoneFailureReason): string {
  switch (reason) {
    case 'INVALID_PHONE':          return 'Enter a valid 10-digit Indian mobile number.';
    case 'PHONE_TAKEN':            return 'This phone number is already in use.';
    case 'USER_NOT_FOUND':         return 'Account not found.';
    case 'STATE_MACHINE_REJECTED': return 'Could not update your account state. Please try again.';
  }
}
