import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const r = await prisma.returnRequest.findUnique({
    where: { id: params.id },
    include: { order: { select: { orderNumber: true } } },
  });
  if (!r || r.userId !== user.id) return jsonError('Not found.', 404);
  return jsonOk({
    return: {
      id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber,
      type: r.type, reason: r.reason, details: r.details, status: r.status,
      refundAmountPaise: r.refundAmountPaise, adminNote: r.adminNote,
      items: JSON.parse(r.itemsJson),
      imageUrls: r.imagesJson ? JSON.parse(r.imagesJson) : [],
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    },
  });
});
