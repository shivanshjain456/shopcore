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

/**
 * GET /api/admin/audit-log — Item 12.
 *
 * Cursor pagination preferred (audit log grows monotonically; OFFSET
 * over millions of rows scans + discards them). Cursor mode is opt-in
 * via `?cursor=…` (or empty `?cursor=` for the first page). Without
 * the cursor param, offset pagination is used for backwards compat
 * with the legacy admin UI.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const entity = sp.get('entity');
  const action = sp.get('action');
  const config = await getStoreConfig();

  const where: Prisma.AuditLogWhereInput = {};
  if (entity) where.entity = entity;
  if (action) where.action = action;

  const includeBlock = {
    actor: { select: { email: true, firstName: true, lastName: true } },
  } as const;

  if (sp.has('cursor')) {
    const { cursor, pageSize, take } = parseCursorParams(sp, config, { defaultPageSize: 50 });
    const fetched = await prisma.auditLog.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip:   cursor ? 1 : 0,
      include: includeBlock,
    });
    return jsonOk(buildCursorPagination(fetched as unknown as Array<Record<string, unknown>>, pageSize, 'id', cursor));
  }

  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, { defaultPageSize: 50 });
  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: includeBlock,
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});
