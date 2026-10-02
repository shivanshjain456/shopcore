/**
 * DELETE /api/compare/[productId] — Item 14. Remove a single product.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireCompareEnabled } from '@/lib/storeConfig/featureGate';
import { removeCompare } from '@/lib/account/compare';

export const dynamic = 'force-dynamic';

export const DELETE = withErrorHandling(async (
  _req: Request,
  { params }: { params: { productId: string } },
) => {
  assertCsrf();
  await requireCompareEnabled();
  const user = await getCurrentUser();
  const entries = await removeCompare(user?.id ?? null, params.productId);
  return jsonOk({
    items: entries.map((e) => ({ productId: e.productId, addedAt: e.addedAt.toISOString() })),
  });
});
