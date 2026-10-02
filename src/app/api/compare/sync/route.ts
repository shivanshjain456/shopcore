/**
 * POST /api/compare/sync — Item 14.
 *
 * Login hook: merge the caller's local productIds into their server
 * compare list. Anonymous callers get a 401 — there's nothing to sync
 * INTO without a user row. The route also clears the cookie on success
 * so the next anonymous-style GET returns the empty list (and the
 * client provider switches to "authed" state).
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { getCurrentUser } from '@/lib/auth/session';
import { requireCompareEnabled } from '@/lib/storeConfig/featureGate';
import { syncCompare, clearCompareCookie, COMPARE_HARD_CAP } from '@/lib/account/compare';

export const dynamic = 'force-dynamic';

const Body = z.object({
  productIds: z.array(z.string().min(1).max(64)).max(COMPARE_HARD_CAP),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireCompareEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in to sync your compare list.', 401, { code: 'UNAUTHENTICATED' });
  await applyRateLimit('compare.sync', req, { userId: user.id });

  const { productIds } = Body.parse(await req.json());
  const entries = await syncCompare(user.id, productIds);
  clearCompareCookie();
  return jsonOk({
    items: entries.map((e) => ({ productId: e.productId, addedAt: e.addedAt.toISOString() })),
  });
});
