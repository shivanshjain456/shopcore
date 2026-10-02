import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
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
    req.nextUrl.searchParams, config, { defaultPageSize: 20 },
  );
  const [total, items] = await Promise.all([
    prisma.promotion.count(),
    prisma.promotion.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  bannerUrl: z.string().trim().max(500).optional().nullable(),
  linkUrl: z.string().trim().max(500).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  validFrom: z.string(),
  validUntil: z.string(),
  position: z.enum(['HOME_HERO', 'HOME_STRIP', 'SIDEBAR']),
  isActive: z.boolean().default(true),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const p = await prisma.promotion.create({ data: {
    ...body,
    validFrom: new Date(body.validFrom), validUntil: new Date(body.validUntil),
  } });
  await audit({ actorId: admin.id, action: 'PROMO_CREATE', entity: 'Promotion', entityId: p.id, after: p });
  return jsonOk({ promotion: p });
});
