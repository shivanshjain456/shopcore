/** GET /api/orders/[id] — single order detail, owner-only. */
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { maskUtr } from '@/lib/checkout/utr';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: {
      items: { include: { product: { select: { slug: true } } } },
      statusHistory: { orderBy: { createdAt: 'asc' } },
      coupon: true,
    },
  });
  if (!order || order.userId !== user.id) return jsonError('Order not found.', 404);
  // Mask UTR before leaving the server — customers see only the last 4
  // characters (e.g. "********5678"). Admin endpoints return the raw UTR.
  const safe = {
    ...order,
    utrNumber: maskUtr(order.utrNumber),
    utrNumberMasked: maskUtr(order.utrNumber),
  };
  return jsonOk({ order: safe });
});
