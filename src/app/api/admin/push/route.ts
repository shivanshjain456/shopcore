/**
 * Push notifications — queued in DB and marked sent.
 * Actual web-push delivery is out of scope for this build (no mobile app yet).
 * Admin can use this for in-app banner placeholders and history.
 */
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
    prisma.pushNotification.count(),
    prisma.pushNotification.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  title: z.string().trim().min(1).max(120),
  body:  z.string().trim().min(1).max(500),
  audience: z.enum(['ALL', 'B2C', 'B2B']),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const p = await prisma.pushNotification.create({ data: { ...body, sentAt: new Date() } });
  await audit({ actorId: admin.id, action: 'PUSH_SEND', entity: 'PushNotification', entityId: p.id, after: body });
  return jsonOk({ push: p });
});
