import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { ZTicketStatus } from '@/lib/enums';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const t = await prisma.supportTicket.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!t) return jsonError('Not found.', 404);
  return jsonOk({ ticket: t });
});

const PatchBody = z.object({
  status: ZTicketStatus.optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = PatchBody.parse(await req.json());
  const existing = await prisma.supportTicket.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  const updated = await prisma.supportTicket.update({ where: { id: existing.id }, data: body });
  await audit({ actorId: admin.id, action: 'TICKET_UPDATE', entity: 'SupportTicket', entityId: existing.id, before: existing, after: updated });
  return jsonOk({ ticket: updated });
});
