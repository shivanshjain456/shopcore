import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { customerCancelOrder } from '@/lib/checkout/placeOrder';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().max(300).optional() }).strict();

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const { reason } = Body.parse(await req.json().catch(() => ({})));
  const r = await customerCancelOrder(user.id, params.id, reason);
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ message: 'Order cancelled.' });
});
