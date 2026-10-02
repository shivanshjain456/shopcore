/** GET /api/orders — current user's orders. Item 12: paginated envelope. */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { maskUtr } from '@/lib/checkout/utr';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  // Item 12 — paginated envelope (was `{ orders: [...] }`, bounded
  // at 100 per response). Default page size 10 for customer-facing
  // lists per spec §2.6.
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 10 },
  );
  const where = { userId: user.id };
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: {
        items: { include: { product: { select: { slug: true, images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } } } } },
      },
    }),
  ]);
  // Mask UTR before leaving the server — see /api/orders/[id] for rationale.
  const items = orders.map((o) => ({
    ...o, utrNumber: maskUtr(o.utrNumber), utrNumberMasked: maskUtr(o.utrNumber),
  }));
  return jsonOk(buildPagination(items, total, page, pageSize));
});
