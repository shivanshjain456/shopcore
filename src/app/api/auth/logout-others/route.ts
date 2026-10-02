/**
 * POST /api/auth/logout-others
 *
 * Convenience alias for /api/auth/logout-all with keepCurrent=true.
 * Revokes every refresh family for the current user EXCEPT the family the
 * requesting browser is currently using.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getSession } from '@/lib/auth/session';
import { revokeOtherFamilies } from '@/lib/auth/refresh';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_req: NextRequest) => {
  assertCsrf();
  const s = await getSession();
  if (!s) return jsonError('Please sign in.', 401);
  const n = await revokeOtherFamilies(s.sub, s.fam, 'LOGOUT_OTHERS');
  return jsonOk({ revokedFamilies: n });
});
