import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { declineQuote } from '@/lib/b2b/quotes';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().trim().max(300).optional() });

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  if (user.role !== 'B2B' || !user.b2bApprovedAt) return jsonError('B2B account required.', 403);
  const { reason } = Body.parse(await req.json().catch(() => ({})));
  const r = await declineQuote(user.id, params.id, reason);
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ declined: true });
});
