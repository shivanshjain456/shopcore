/** GET /api/admin/orders — paginated list with filters. Item 12:
 *  supports BOTH offset pagination (`?page=&pageSize=`) and
 *  cursor pagination (`?cursor=&pageSize=`). Cursor mode skips the
 *  COUNT(*) query — useful when the order table grows large. */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
import {
  parsePaginationParams, parseCursorParams,
  buildPagination, buildCursorPagination,
} from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') ?? '').trim();
  const status = sp.get('status');
  const paymentStatus = sp.get('paymentStatus');
  const config = await getStoreConfig();

  const where: Prisma.OrderWhereInput = {};
  if (q) where.OR = [
    { orderNumber: { contains: q } }, { user: { email: { contains: q } } }, { utrNumber: { contains: q } },
  ];
  if (status) where.status = status;
  if (paymentStatus) where.paymentStatus = paymentStatus;

  const includeBlock = {
    user: { select: { email: true, firstName: true, lastName: true, companyName: true } },
    _count: { select: { items: true } },
  } as const;

  // Cursor mode — opt-in via `?cursor=...` (or `?cursor=` alone to
  // start cursor pagination). Skips COUNT(*) entirely.
  if (sp.has('cursor')) {
    const { cursor, pageSize, take } = parseCursorParams(sp, config, { defaultPageSize: 20 });
    const fetched = await prisma.order.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip:   cursor ? 1 : 0,
      include: includeBlock,
    });
    return jsonOk(buildCursorPagination(fetched as unknown as Array<Record<string, unknown>>, pageSize, 'id', cursor));
  }

  // Offset mode — the standard envelope.
  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, { defaultPageSize: 20 });
  const [total, items] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: includeBlock,
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});
