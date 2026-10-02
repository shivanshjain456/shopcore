import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import {
  parsePaginationParams, parseCursorParams,
  buildPagination, buildCursorPagination,
} from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/tickets — Item 12 Phase 2.
 *
 * Dual-mode pagination: cursor (`?cursor=`) opt-in for large
 * datasets; offset by default for backwards compat.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');
  const where = status ? { status } : {};
  const config = await getStoreConfig();
  const include = {
    user:   { select: { email: true, firstName: true, lastName: true } },
    _count: { select: { messages: true } },
  } as const;

  if (sp.has('cursor')) {
    const { cursor, pageSize, take } = parseCursorParams(sp, config, { defaultPageSize: 20 });
    const fetched = await prisma.supportTicket.findMany({
      where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip:   cursor ? 1 : 0,
      include,
    });
    return jsonOk(buildCursorPagination(fetched as unknown as Array<Record<string, unknown>>, pageSize, 'id', cursor));
  }

  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, { defaultPageSize: 20 });
  const [total, items] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take, include,
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});
