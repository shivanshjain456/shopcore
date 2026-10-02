import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const status = req.nextUrl.searchParams.get('status');
  const where = status ? { status } : {};
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 20 },
  );
  const [total, rows] = await Promise.all([
    prisma.quoteRequest.count({ where }),
    prisma.quoteRequest.findMany({
      where,
      orderBy: { updatedAt: 'desc' }, skip, take,
      include: { user: { select: { email: true, firstName: true, lastName: true, companyName: true, gstin: true } } },
    }),
  ]);
  const items = rows.map((q) => ({
    id: q.id, status: q.status, note: q.note, createdAt: q.createdAt, updatedAt: q.updatedAt,
    user: q.user,
    lineCount: (JSON.parse(q.itemsJson) as unknown[]).length,
    quote: q.quoteJson ? JSON.parse(q.quoteJson) : null,
  }));
  return jsonOk(buildPagination(items, total, page, pageSize));
});
