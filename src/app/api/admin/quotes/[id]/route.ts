import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { postCounterQuote } from '@/lib/admin/quotes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  validForDays: z.number().int().min(1).max(60),
  adminNote: z.string().trim().max(500).optional().nullable(),
  lines: z.array(z.object({
    productId: z.string().min(1),
    variantId: z.string().nullable().optional(),
    quantity:  z.number().int().min(1).max(10000),
    unitPricePaise: z.number().int().min(0),
  })).min(1).max(200),
});

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const q = await prisma.quoteRequest.findUnique({
    where: { id: params.id },
    include: { user: { select: { id: true, email: true, companyName: true, gstin: true } } },
  });
  if (!q) return jsonError('Not found.', 404);
  return jsonOk({
    quote: {
      id: q.id, status: q.status, note: q.note,
      createdAt: q.createdAt, updatedAt: q.updatedAt,
      user: q.user,
      lines: JSON.parse(q.itemsJson),
      quote: q.quoteJson ? JSON.parse(q.quoteJson) : null,
    },
  });
});

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = Body.parse(await req.json());
  const r = await postCounterQuote({ quoteId: params.id, ...body });
  if (!r.ok) return jsonError(r.reason, 400);
  await audit({ actorId: admin.id, action: 'QUOTE_ANSWER', entity: 'QuoteRequest', entityId: params.id, after: body });
  return jsonOk({ quoted: true });
});
