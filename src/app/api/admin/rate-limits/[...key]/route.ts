/**
 * DELETE /api/admin/rate-limits/[...key]
 *
 * Resets a specific rate-limit bucket. Used by support when a legitimate
 * user reports being locked out (e.g. they forgot their password and
 * triggered the burst window).
 *
 * Catch-all route segment `[...key]`) because real rate-limit keys
 * contain colons (`rl:ip:auth.login:abc123...`) which would be parsed
 * as nested path segments otherwise. Next.js joins the segments back
 * into an array on `params.key`.
 *
 * Auth: requireAdminUser() + assertCsrf().
 * Always writes an AuditLog row — admin overrides of security controls
 * must be fully traceable.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { store } from '@/lib/security/rateLimitStore';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export const DELETE = withErrorHandling(async (
  _req: NextRequest,
  { params }: { params: { key: string[] } },
) => {
  assertCsrf();
  let admin;
  try { admin = await requireAdminUser(); }
  catch (e) { if (e instanceof AdminGuardError) return e.response; throw e; }

  // Reassemble the colon-joined key from the catch-all segments.
  const key = (params.key ?? []).join('/');
  if (!key) return jsonError('Missing rate-limit key.', 400, { code: 'BAD_KEY' });

  // Existence check is optional — `store.reset` is idempotent on absent
  // keys — but we surface a different log line for the no-op case so
  // ops can spot stale support runbooks.
  const before = await store.peek(key);
  await store.reset(key);

  await audit({
    actorId:  admin.id,
    action:   'RATE_LIMIT_RESET',
    entity:   'RateLimit',
    entityId: key,
    before,
    after:    null,
  });
  log.info('rate_limit.reset', { key, adminId: admin.id, hadEntry: before !== null });

  return jsonOk({ key, resetAt: Date.now(), hadEntry: before !== null });
});
