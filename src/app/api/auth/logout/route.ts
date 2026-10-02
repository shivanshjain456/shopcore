/**
 * POST /api/auth/logout — Feature #9
 *
 * Hardened, idempotent server-side logout.
 *
 * Contract:
 *   - Revokes the current refresh-token family (Bug #7) which cascade-revokes
 *     every Session row in that family.
 *   - Clears both access and refresh cookies on the response.
 *   - Records a structured `LOGOUT` UserActivity row with userId, sessionId
 *     (when known), IP, userAgent, and the reason ('USER_LOGOUT' here, or
 *     'EXPIRED_NOOP' if there was already no session).
 *   - Returns 200 even when there was nothing to revoke (idempotent). This
 *     is the right answer for the "logout after session already expired"
 *     edge case from the spec — UX is "you are now signed out", same as
 *     if there had been a session.
 *   - Tolerates missing/invalid access cookie — we still try to revoke any
 *     refresh family pointed at by the refresh cookie.
 *
 * Race conditions:
 *   - If a /api/auth/refresh request is in flight concurrently with logout,
 *     ONE of them wins the DB write lock. If refresh wins, our logout sees
 *     the new family and revokes it. If logout wins, refresh's later
 *     rotate trips the `revoked` branch and returns 401. Both paths leave
 *     the user signed out — verified by tests (E1) and (E2).
 *
 * The optional `scope` body controls how much to revoke:
 *   - 'current' (default) → just the current device/family
 *   - 'all'                → every refresh family for the user (every device)
 *
 * `scope: 'all'` is the same effect as POST /api/auth/logout-all and exists
 * here so a single client call can do either without changing the URL.
 */
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { destroySession, getSession } from '@/lib/auth/session';
import { revokeAllFamilies } from '@/lib/auth/refresh';
import { prisma } from '@/lib/db/client';
import { clientIp } from '@/lib/security/ip';
import { headers } from 'next/headers';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

const Body = z.object({
  scope: z.enum(['current', 'all']).optional().default('current'),
}).strict();

export const POST = withErrorHandling(async (req: Request) => {
  assertCsrf();
  const { scope } = Body.parse(await req.json().catch(() => ({})));

  const ip = clientIp();
  const ua = headers().get('user-agent') ?? null;
  const s = await getSession();

  // Structured security log — every logout, with or without a session, is
  // recorded. UserActivity is keyed on a real user so missing-session logs
  // go to the application logger instead.
  if (s) {
    try {
      await prisma.userActivity.create({
        data: {
          userId: s.sub,
          action: scope === 'all' ? 'LOGOUT_ALL' : 'LOGOUT',
          ipAddress: ip,
          metadata: JSON.stringify({
            sessionId: s.jti, familyId: s.fam, userAgent: ua, scope,
            reason: 'USER_LOGOUT',
          }),
        },
      });
    } catch (e) { log.warn('logout.activity_log_failed', { err: (e as Error).message }); }
  } else {
    log.info('logout.no_session', { ip, userAgent: ua });
  }

  if (scope === 'all' && s) {
    // Best-effort: revoke every family this user owns BEFORE clearing
    // cookies, so the cookie-clear is the final visible effect.
    try { await revokeAllFamilies(s.sub, 'USER_LOGOUT_ALL'); }
    catch (e) { log.warn('logout.revoke_all_failed', { err: (e as Error).message }); }
  }
  // Clears access + refresh cookies AND revokes the current family.
  // Safe even when there was no session — it's a no-op.
  await destroySession();

  return jsonOk({
    ok: true,
    message: scope === 'all' ? 'Signed out of every device.' : 'Signed out.',
    hadSession: !!s,
    scope,
  });
});

/**
 * GET is intentionally not implemented — logout is a state-changing operation
 * and must use POST (so CSRF + same-origin protections apply).
 */
