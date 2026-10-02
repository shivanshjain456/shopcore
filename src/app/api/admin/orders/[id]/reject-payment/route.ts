import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { rejectPayment } from '@/lib/admin/orders';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().trim().min(2).max(300), restoreStock: z.boolean().default(true) });

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { reason, restoreStock } = Body.parse(await req.json());
  const r = await rejectPayment(admin.id, params.id, reason, restoreStock);
  if (!r.ok) return jsonError(r.reason, 400);
  await audit({ actorId: admin.id, action: 'PAYMENT_REJECT', entity: 'Order', entityId: params.id, after: { reason } });
  return jsonOk({ rejected: true });
});
