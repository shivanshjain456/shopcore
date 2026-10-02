/**
 * GET /api/wishlist — returns the productIds the user has wishlisted.
 *
 * This is a per-user SET-MEMBERSHIP query, not an entity list — the
 * client uses it to ask "is product X wishlisted?" across the
 * storefront. Capped at `paginationMaxSize` so the response can never
 * become a memory bomb, but it does NOT use the Item-12 paginated
 * envelope (clients consume the raw `ids` array, not an items list).
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonOk({ ids: [] }); // anonymous → empty list, no 401 to avoid console noise
  // Item 12 — bound the result at the config cap (defensive against
  // the rare runaway-wishlist case; the realistic upper bound for a
  // single user is a few dozen items).
  const config = await getStoreConfig();
  const cap = Math.max(100, Math.floor(config.performance.paginationMaxSize ?? 100));
  const items = await prisma.wishlistItem.findMany({
    where: { userId: user.id },
    select: { productId: true },
    take: cap,
  });
  return jsonOk({ ids: items.map((i) => i.productId) });
});
