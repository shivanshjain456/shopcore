import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { acceptQuote } from '@/lib/b2b/quotes';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  if (user.role !== 'B2B' || !user.b2bApprovedAt) return jsonError('B2B account required.', 403);
  const r = await acceptQuote(user.id, params.id);
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ couponCode: r.couponCode });
});
