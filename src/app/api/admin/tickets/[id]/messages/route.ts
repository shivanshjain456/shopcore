import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const Body = z.object({ body: z.string().trim().min(1).max(4000) });

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const t = await prisma.supportTicket.findUnique({ where: { id: params.id } });
  if (!t) return jsonError('Not found.', 404);
  const { body } = Body.parse(await req.json());
  await prisma.ticketMessage.create({ data: { ticketId: t.id, authorId: admin.id, body } });
  await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'AWAITING_CUSTOMER' } });
  await audit({ actorId: admin.id, action: 'TICKET_REPLY', entity: 'SupportTicket', entityId: t.id });
  return jsonOk({ posted: true });
});
