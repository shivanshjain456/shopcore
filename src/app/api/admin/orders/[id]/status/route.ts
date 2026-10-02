import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { advanceStatus } from '@/lib/admin/orders';

export const dynamic = 'force-dynamic';

const Body = z.object({
  to:   z.enum(['PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']),
  note: z.string().trim().max(300).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { to, note } = Body.parse(await req.json());
  const r = await advanceStatus(admin.id, params.id, to, note);
  if (!r.ok) return jsonError(r.reason, 400);
  await audit({ actorId: admin.id, action: 'ORDER_STATUS_ADVANCE', entity: 'Order', entityId: params.id, after: { to, note } });
  return jsonOk({ moved: true });
});
