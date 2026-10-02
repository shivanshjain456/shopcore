/** GET /api/cart — server cart for logged-in users. 401 for guests. */
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { getCartView } from '@/lib/catalog/cart';
import { serializeCartForApi } from '@/lib/catalog/cartView';
import { priceCtxForUser } from '@/lib/catalog/pricing';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Not authenticated.', 401);
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const view = await getCartView(user.id, priceCtxForUser(user, tier));
  return jsonOk(serializeCartForApi(view));
});
