import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { requireTicketsEnabled } from '@/lib/storeConfig/featureGate';
import { prisma } from '@/lib/db/client';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  // Item 12 — paginated envelope (was `{ tickets: [...] }`).
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 10 },
  );
  const where = { userId: user.id };
  const [total, rows] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take,
      include: { messages: { select: { id: true }, take: 1 } },
    }),
  ]);
  const items = rows.map((t) => ({
    id: t.id, subject: t.subject, category: t.category, orderId: t.orderId, status: t.status, priority: t.priority,
    createdAt: t.createdAt, updatedAt: t.updatedAt, messageCount: t.messages.length,
  }));
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  subject:  z.string().trim().min(2).max(160),
  category: z.enum(['ORDER', 'PAYMENT', 'RETURN', 'TECH', 'OTHER']),
  orderId:  z.string().optional().nullable(),
  body:     z.string().trim().min(2).max(4000),
  imageUrls: z.array(z.string().startsWith('/api/uploads/')).max(5).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  // Opening support tickets requires an ACTIVE account. Existing
  // tickets are still readable for non-ACTIVE users (the GET handler
  // above only requires authentication). Auth runs BEFORE the feature
  // gate so unauthenticated callers get 401, not 403 FEATURE_DISABLED.
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  // Item 8 — feature gate AFTER auth.
  await requireTicketsEnabled();
  const data = Body.parse(await req.json());
  if (data.orderId) {
    const o = await prisma.order.findUnique({ where: { id: data.orderId } });
    if (!o || o.userId !== user!.id) return jsonError('Order not found.', 404);
  }
  const t = await prisma.supportTicket.create({
    data: {
      userId: user!.id, subject: data.subject, category: data.category,
      orderId: data.orderId ?? null, status: 'OPEN', priority: 'NORMAL',
      messages: { create: {
        authorId: user!.id, body: data.body,
        imagesJson: data.imageUrls && data.imageUrls.length ? JSON.stringify(data.imageUrls) : null,
      } },
    },
  });
  return jsonOk({ id: t.id });
});
