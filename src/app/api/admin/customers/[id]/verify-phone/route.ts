/**
 * POST /api/admin/customers/[id]/verify-phone
 *
 * Admin override for support cases — manually marks a customer's phone
 * verified WITHOUT going through Firebase. Always writes an AuditLog
 * row (ADMIN_PHONE_VERIFY_OVERRIDE) — every override must be traceable.
 *
 * Auth: requireAdminUser (admin session).
 * CSRF: required.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { markPhoneVerifiedByAdmin } from '@/lib/auth/phoneVerification';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const r = await markPhoneVerifiedByAdmin(params.id, admin.id);
  if (!r.ok) {
    const status = r.reason === 'USER_NOT_FOUND' ? 404
                 : r.reason === 'STATE_MACHINE_REJECTED' ? 409
                 : 400;
    return jsonError(r.detail ?? r.reason, status, { code: r.reason });
  }
  return jsonOk({
    phoneVerified: true,
    accountStatus: r.data.accountStatus,
    alreadyVerified: r.data.alreadyVerified,
  });
});
