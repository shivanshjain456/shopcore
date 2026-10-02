/**
 * POST /api/account/password — Feature #11.
 *
 * Change the current user's password. Requires the current password as
 * proof-of-possession even when a session cookie is present (defence
 * against session-hijack → password change → full account takeover).
 *
 * Same shared validator as signup (lib/auth/passwordPolicy), so all
 * complexity rules and the blocklist are enforced identically. After a
 * successful change, every refresh-family for this user is revoked —
 * the requesting browser is signed out and any other device is too.
 * This matches the Bug #7 "password change kicks every device" pattern.
 *
 * The plaintext password is never logged, returned, or persisted; it's
 * validated then hashed via the existing bcrypt helper.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser, destroySession } from '@/lib/auth/session';
import { revokeAllFamilies } from '@/lib/auth/refresh';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { assertPasswordOk, PASSWORD_POLICY } from '@/lib/auth/passwordPolicy';
import { prisma } from '@/lib/db/client';
import { clientIp } from '@/lib/security/ip';

export const dynamic = 'force-dynamic';

const Body = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_POLICY.maxLength),
  newPassword:     z.string().min(1).max(PASSWORD_POLICY.maxLength),
  confirmPassword: z.string().min(1).max(PASSWORD_POLICY.maxLength),
}).strict()
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'New password and confirmation do not match.',
    path: ['confirmPassword'],
  });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);

  const { currentPassword, newPassword } = Body.parse(await req.json().catch(() => ({})));

  // Proof-of-possession of the current password BEFORE we even bother
  // validating the new one — prevents leaking policy details (or even
  // the size of the blocklist's response time) to anyone who managed to
  // smuggle in via a stolen session cookie.
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return jsonError('Current password is incorrect.', 401, { code: 'BAD_CURRENT_PASSWORD' });

  // Reject "set new password to current password" — no-op + security smell.
  if (newPassword === currentPassword) {
    return jsonError('New password must be different from your current password.', 400, { code: 'PASSWORD_UNCHANGED' });
  }

  // Same policy as signup — email check fires so "myname@gmail.com" users
  // can't set "myname1!" as a password.
  try { assertPasswordOk(newPassword, { email: user.email }); }
  catch (e) { return jsonError((e as Error).message, 400, { code: 'PASSWORD_POLICY' }); }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

  // Audit log (no plaintext, ever).
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'PASSWORD_CHANGE', ipAddress: clientIp() },
  });

  // Security: revoke every other session AND the current one. The
  // requesting browser will need to sign in again with the new password.
  await revokeAllFamilies(user.id, 'PASSWORD_CHANGE');
  await destroySession();

  return jsonOk({ ok: true, message: 'Password changed. Please sign in again.' });
});
