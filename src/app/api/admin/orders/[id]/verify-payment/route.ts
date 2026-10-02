import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { verifyPayment } from '@/lib/admin/orders';

export const dynamic = 'force-dynamic';

/**
 * Body contract for admin payment verification.
 *
 *   amountMatches  — MANDATORY checkbox; admin MUST attest the bank credit
 *                    equals the order's grand total. Absence or `false`
 *                    causes a hard rejection (see verifyPayment()).
 *   bankReference  — optional: the UTR shown in the admin's bank statement.
 *                    If supplied it must equal the UTR on the order after
 *                    sanitisation — else the verify is rejected.
 *   note           — optional free-text audit note.
 */
const Body = z.object({
  amountMatches: z.boolean(),
  bankReference: z.string().trim().max(64).optional().nullable(),
  note:          z.string().trim().max(300).optional().nullable(),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const parsed = Body.parse(await req.json().catch(() => ({})));
  const r = await verifyPayment(admin.id, params.id, parsed.note ?? null, {
    amountMatches: parsed.amountMatches,
    bankReference: parsed.bankReference ?? null,
  });
  if (!r.ok) return jsonError(r.reason, 400);
  await audit({
    actorId: admin.id, action: 'PAYMENT_VERIFY', entity: 'Order', entityId: params.id,
    after: { note: parsed.note ?? null, amountMatches: parsed.amountMatches, hasBankReference: !!parsed.bankReference },
  });
  return jsonOk({ verified: true });
});
