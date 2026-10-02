import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { createQuote, listQuotesForUser } from '@/lib/b2b/quotes';
import { requireB2BEnabled } from '@/lib/storeConfig/featureGate';

export const dynamic = 'force-dynamic';

const Body = z.object({
  note: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(z.object({
    productId: z.string().min(1),
    variantId: z.string().nullable().optional(),
    quantity:  z.number().int().min(1).max(1000),
    note:      z.string().trim().max(300).optional().nullable(),
  })).min(1).max(100),
});

export const GET = withErrorHandling(async () => {
  await requireB2BEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  if (user.role !== 'B2B' || !user.b2bApprovedAt) return jsonError('B2B account required.', 403);
  const quotes = await listQuotesForUser(user.id);
  return jsonOk({ quotes });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireB2BEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  if (user.role !== 'B2B' || !user.b2bApprovedAt) return jsonError('B2B account required.', 403);
  const data = Body.parse(await req.json());
  const r = await createQuote({ userId: user.id, ...data });
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ id: r.id });
});
