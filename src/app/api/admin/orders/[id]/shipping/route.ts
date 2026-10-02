import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { setShipping } from '@/lib/admin/orders';

export const dynamic = 'force-dynamic';

const Body = z.object({
  courierName: z.string().trim().min(1).max(80),
  trackingNumber: z.string().trim().max(80).optional().nullable(),
  trackingUrl: z.string().trim().url().max(500).optional().nullable(),
});

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const r = await setShipping(admin.id, params.id, body.courierName, body.trackingNumber, body.trackingUrl);
  if (!r.ok) return jsonError(r.reason, 400);
  await audit({ actorId: admin.id, action: 'ORDER_SHIPPING_SET', entity: 'Order', entityId: params.id, after: body });
  return jsonOk({ saved: true });
});
