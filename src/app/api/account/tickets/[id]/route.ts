import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const t = await prisma.supportTicket.findUnique({
    where: { id: params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!t || t.userId !== user.id) return jsonError('Not found.', 404);
  return jsonOk({ ticket: {
    id: t.id, subject: t.subject, category: t.category, orderId: t.orderId, status: t.status, priority: t.priority,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    messages: t.messages.map((m) => ({
      id: m.id, authorId: m.authorId, body: m.body,
      imageUrls: m.imagesJson ? JSON.parse(m.imagesJson) : [],
      isOwn: m.authorId === user.id,
      createdAt: m.createdAt,
    })),
  } });
});
