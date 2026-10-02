import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: {
      items: true,
      statusHistory: { orderBy: { createdAt: 'asc' } },
      coupon: true,
      user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, companyName: true, gstin: true, role: true } },
    },
  });
  if (!order) return jsonError('Not found.', 404);
  return jsonOk({ order });
});
