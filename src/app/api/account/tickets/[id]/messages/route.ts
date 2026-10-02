import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const Body = z.object({
  body: z.string().trim().min(1).max(4000),
  imageUrls: z.array(z.string().startsWith('/api/uploads/')).max(5).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  const t = await prisma.supportTicket.findUnique({ where: { id: params.id } });
  if (!t || t.userId !== user!.id) return jsonError('Not found.', 404);
  if (t.status === 'CLOSED') return jsonError('Ticket is closed.', 400);
  const data = Body.parse(await req.json());
  await prisma.ticketMessage.create({
    data: { ticketId: t.id, authorId: user!.id, body: data.body, imagesJson: data.imageUrls?.length ? JSON.stringify(data.imageUrls) : null },
  });
  await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'AWAITING_AGENT' } });
  return jsonOk({ posted: true });
});
