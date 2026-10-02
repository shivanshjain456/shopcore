import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { ZReturnStatus } from '@/lib/enums';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  status: ZReturnStatus.optional(),
  adminNote: z.string().trim().max(1000).optional().nullable(),
  refundAmountPaise: z.number().int().min(0).optional().nullable(),
});

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const r = await prisma.returnRequest.findUnique({
    where: { id: params.id },
    include: { order: { select: { id: true, orderNumber: true } }, user: { select: { email: true, firstName: true, lastName: true } } },
  });
  if (!r) return jsonError('Not found.', 404);
  return jsonOk({ return: { ...r, items: JSON.parse(r.itemsJson), imageUrls: r.imagesJson ? JSON.parse(r.imagesJson) : [] } });
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = PatchBody.parse(await req.json());
  const existing = await prisma.returnRequest.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  const updated = await prisma.returnRequest.update({ where: { id: existing.id }, data: body });
  await audit({ actorId: admin.id, action: 'RETURN_UPDATE', entity: 'ReturnRequest', entityId: existing.id, before: existing, after: updated });
  return jsonOk({ return: updated });
});
