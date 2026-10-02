import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { reorderFromOrder } from '@/lib/account/reorder';

export const dynamic = 'force-dynamic';

const Body = z.object({ orderId: z.string().min(1) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const { orderId } = Body.parse(await req.json());
  const r = await reorderFromOrder(user.id, orderId);
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk(r);
});
