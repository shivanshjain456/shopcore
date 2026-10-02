import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { ZDiscountType } from '@/lib/enums';
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
    prisma.coupon.count(),
    prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  code: z.string().trim().min(2).max(40).transform((s) => s.toUpperCase()),
  description: z.string().trim().max(200).optional().nullable(),
  discountType: ZDiscountType,
  value: z.number().int().min(0),
  minOrderPaise: z.number().int().min(0).default(0),
  maxDiscountPaise: z.number().int().min(0).optional().nullable(),
  usageLimit: z.number().int().min(0).optional().nullable(),
  perUserLimit: z.number().int().min(0).optional().nullable(),
  validFrom: z.string(), // ISO
  validUntil: z.string(),
  appliesToB2C: z.boolean().default(true),
  appliesToB2B: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const c = await prisma.coupon.create({ data: {
    ...body,
    validFrom: new Date(body.validFrom), validUntil: new Date(body.validUntil),
  } });
  await audit({ actorId: admin.id, action: 'COUPON_CREATE', entity: 'Coupon', entityId: c.id, after: c });
  return jsonOk({ coupon: c });
});
