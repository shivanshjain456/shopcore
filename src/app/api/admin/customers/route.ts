import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') ?? '').trim();
  const role = sp.get('role');
  const status = sp.get('status');
  // Item 12 — canonical pagination.
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, {
    defaultPageSize: 20,
  });

  const where: Prisma.UserWhereInput = {};
  if (q) where.OR = [
    { email: { contains: q } }, { phone: { contains: q } },
    { firstName: { contains: q } }, { lastName: { contains: q } }, { companyName: { contains: q } },
    { gstin: { contains: q } },
  ];
  if (role)   where.role   = role;
  if (status) where.status = status;

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: {
        b2bTier: true,
        _count: { select: { orders: true, reviews: true } },
      },
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});
