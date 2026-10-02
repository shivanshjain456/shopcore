/**
 * DELETE /api/auth/sessions/[id]  — Feature #9 device-management surface.
 *
 * Revoke ONE refresh-token family by id (and cascade revoke its sessions).
 * The caller must own the family. Returns 200 if revoked, 404 if not found
 * or not owned, 200 (idempotent) if it was already revoked.
 *
 * Refusing to revoke the current family is intentional — use POST
 * /api/auth/logout for "this device". `?force=1` overrides for the rare
 * "kick myself" case.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getSession, destroySession } from '@/lib/auth/session';
import { revokeFamily } from '@/lib/auth/refresh';
import { prisma } from '@/lib/db/client';
import { clientIp } from '@/lib/security/ip';
import { headers } from 'next/headers';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const s = await getSession();
  if (!s) return jsonError('Please sign in.', 401);

  const family = await prisma.refreshTokenFamily.findUnique({ where: { id: params.id } });
  if (!family || family.userId !== s.sub) return jsonError('Session not found.', 404);

  const isCurrent = family.id === s.fam;
  const force = new URL(req.url).searchParams.get('force') === '1';
  if (isCurrent && !force) {
    return jsonError(
      'Use POST /api/auth/logout to sign out of THIS device, or pass ?force=1.',
      409, { code: 'CURRENT_FAMILY' },
    );
  }

  if (!family.revokedAt) await revokeFamily(family.id, 'USER_DEVICE_REVOKE');

  try {
    await prisma.userActivity.create({
      data: {
        userId: s.sub, action: 'SESSION_REVOKE', ipAddress: clientIp(),
        metadata: JSON.stringify({
          revokedFamilyId: family.id, byFamilyId: s.fam, byUserAgent: headers().get('user-agent') ?? null,
        }),
      },
    });
  } catch (e) { log.warn('logout.session_revoke_log_failed', { err: (e as Error).message }); }

  // If the user revoked their OWN current family with ?force=1, also clear
  // cookies so the next request requires re-auth.
  if (isCurrent && force) await destroySession();

  return jsonOk({ revoked: true, wasCurrent: isCurrent });
});
