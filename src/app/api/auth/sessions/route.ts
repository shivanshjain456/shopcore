/**
 * GET /api/auth/sessions
 *   List the current user's active refresh-token families (devices/sessions).
 *   Used by the "Where am I signed in?" UI.
 *
 *   Returns the family id, when it started, the IP & user-agent it began on,
 *   the absolute-expiry, and a `current` flag for the family the requesting
 *   browser is using right now.
 */
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const s = await getSession();
  if (!s) return jsonError('Please sign in.', 401);

  // PAGINATION-EXEMPT: scoped to the current user; active sessions are bounded per user.
  const fams = await prisma.refreshTokenFamily.findMany({
    where: { userId: s.sub, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, ipAddress: true, userAgent: true,
      absoluteExpiresAt: true, createdAt: true,
    },
  });
  return jsonOk({
    sessions: fams.map((f) => ({
      id: f.id,
      ipAddress: f.ipAddress,
      userAgent: f.userAgent,
      createdAt: f.createdAt.toISOString(),
      absoluteExpiresAt: f.absoluteExpiresAt.toISOString(),
      current: f.id === s.fam,
    })),
  });
});
