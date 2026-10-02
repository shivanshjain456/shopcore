import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { createReturn, checkOrderEligibility } from '@/lib/account/returns';
import { ZReturnType } from '@/lib/enums';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const eligOrderId = req.nextUrl.searchParams.get('orderId');
  if (eligOrderId) {
    return jsonOk({ eligibility: await checkOrderEligibility(user.id, eligOrderId) });
  }
  // Item 12 — paginated envelope (was `{ returns: [...] }`).
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 10 },
  );
  const where = { userId: user.id };
  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: { order: { select: { orderNumber: true } } },
    }),
  ]);
  const items = rows.map((r) => ({
    id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber,
    type: r.type, reason: r.reason, status: r.status, refundAmountPaise: r.refundAmountPaise,
    createdAt: r.createdAt, items: JSON.parse(r.itemsJson),
  }));
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  orderId:   z.string().min(1),
  type:      ZReturnType,
  reason:    z.string().trim().min(2).max(200),
  details:   z.string().trim().max(1000).optional().nullable(),
  items:     z.array(z.object({ orderItemId: z.string().min(1), quantity: z.number().int().min(1) })).min(1).max(20),
  imageUrls: z.array(z.string().startsWith('/api/uploads/')).max(8).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  // Returns can only be filed by ACTIVE accounts — a SUSPENDED user
  // shouldn't be able to initiate refund flows.
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  const body = Body.parse(await req.json());
  const r = await createReturn({ userId: user!.id, ...body });
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ id: r.id });
});
