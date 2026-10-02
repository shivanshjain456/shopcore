/**
 * POST /api/auth/logout-all
 *   Revoke EVERY session + EVERY refresh-token family for the current user.
 *   The requesting browser is logged out too. Use after password change, or
 *   when the user clicks "Sign out of all devices".
 *
 * POST /api/auth/logout-others   (body: { keepCurrent: true })
 *   Revoke every family EXCEPT the one the current browser is using.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getSession, destroySession } from '@/lib/auth/session';
import { revokeAllFamilies } from '@/lib/auth/refresh';

export const dynamic = 'force-dynamic';

const Body = z.object({
  // Default semantics: kick EVERY session. Pass keepCurrent=true to retain the
  // current browser (called via /api/auth/logout-others below; same handler).
  keepCurrent: z.boolean().optional().default(false),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const s = await getSession();
  if (!s) return jsonError('Please sign in.', 401);
  const body = Body.parse(await req.json().catch(() => ({})));

  if (body.keepCurrent) {
    const { revokeOtherFamilies } = await import('@/lib/auth/refresh');
    const n = await revokeOtherFamilies(s.sub, s.fam, 'LOGOUT_OTHERS');
    return jsonOk({ revokedFamilies: n, keptCurrent: true });
  }

  const n = await revokeAllFamilies(s.sub, 'LOGOUT_ALL');
  // Also clear THIS browser's cookies
  await destroySession();
  return jsonOk({ revokedFamilies: n, keptCurrent: false });
});
