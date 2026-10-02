import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { getQuoteForUser } from '@/lib/b2b/quotes';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const q = await getQuoteForUser(user.id, params.id);
  if (!q) return jsonError('Not found.', 404);
  return jsonOk({ quote: q });
});
