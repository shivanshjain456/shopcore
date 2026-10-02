import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 50 },
  );
  const [total, items] = await Promise.all([
    prisma.category.count(),
    prisma.category.findMany({
      orderBy: { sortOrder: 'asc' },
      skip, take,
      include: { _count: { select: { products: true } } },
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

// Item 17 — accept the new asset fields. All optional; null clears.
const Body = z.object({
  name:        z.string().trim().min(1).max(60),
  slug:        z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/),
  description: z.string().trim().max(500).optional().nullable(),
  sortOrder:   z.number().int().min(0).default(0),
  isActive:    z.boolean().default(true),
  imageUrl:    z.string().trim().max(500).nullish(),
  bannerUrl:   z.string().trim().max(500).nullish(),
  iconUrl:     z.string().trim().max(500).nullish(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const c = await prisma.category.create({ data: body });
  await audit({ actorId: admin.id, action: 'CATEGORY_CREATE', entity: 'Category', entityId: c.id, after: c });
  return jsonOk({ category: c });
});
