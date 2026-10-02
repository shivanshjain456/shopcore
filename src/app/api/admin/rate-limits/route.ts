/**
 * GET /api/admin/rate-limits — admin-only read-only inspection of the
 * in-memory rate-limit store. Returns the registered policies plus
 * currently active keys (with hashed identifiers — never raw IPs).
 *
 * For support use: when a legitimate user reports being locked out,
 * an admin can identify the bucket from the policy + remaining
 * counters here, then call DELETE /api/admin/rate-limits/[key] to
 * reset it.
 *
 * No CSRF (read-only). Auth via `requireAdminUser()`.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { store } from '@/lib/security/rateLimitStore';
import { RATE_LIMIT_POLICIES } from '@/lib/security/rateLimitPolicies';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  try { await requireAdminUser(); }
  catch (e) { if (e instanceof AdminGuardError) return e.response; throw e; }

  // Pull EVERY active key. At our scale (≤500 users) this is a few
  // hundred entries max; for future scale, paginate or restrict by
  // policy prefix.
  const allKeys = await store.keys('*');
  const activeKeys = (await Promise.all(allKeys.map(async (key) => {
    const entry = await store.peek(key);
    if (!entry) return null;
    return { key, count: entry.count, resetAt: entry.resetAt };
  }))).filter((x): x is { key: string; count: number; resetAt: number } => x !== null);

  return jsonOk({
    policies: Object.values(RATE_LIMIT_POLICIES),
    activeKeys,
    storeSize: store.size(),
  });
});
