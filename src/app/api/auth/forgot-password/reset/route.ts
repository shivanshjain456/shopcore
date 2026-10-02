/**
 * POST /api/auth/forgot-password/reset
 *
 * Body: { resetToken, newPassword, confirmPassword }
 *
 *   - Validates the reset token (hash lookup, single-use, expiry)
 *   - Runs the new password through the SHARED validator
 *     (lib/auth/passwordPolicy — Feature #11) with the user's email
 *   - Hashes via the existing bcrypt helper (hashing logic untouched)
 *   - Rejects re-use of the current password
 *   - Revokes EVERY refresh-token family (same path as logout / password-change)
 *
 * Tokens are tombstoned, never deleted. The plaintext token is never
 * logged, returned to anyone else, or persisted in plaintext.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { ForgotPasswordResetSchema } from '@/lib/auth/schemas';
import { consumeResetToken } from '@/lib/auth/passwordReset';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const ip = clientIp();

  await applyRateLimit('auth.forgot_password.reset', req);

  const { resetToken, newPassword } =
    ForgotPasswordResetSchema.parse(await req.json().catch(() => ({})));

  const r = await consumeResetToken({ resetToken, newPassword, ipAddress: ip });
  if (!r.ok) {
    return jsonError(r.reason, r.status ?? 400, { code: r.code });
  }

  return jsonOk({
    message: 'Password updated. Please sign in with your new password.',
  });
});
