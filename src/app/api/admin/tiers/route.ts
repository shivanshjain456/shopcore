import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  // PAGINATION-EXEMPT: B2B tiers are a fixed lookup table (≤ 10 rows).
  const items = await prisma.b2BTier.findMany({ where: { isActive: true }, orderBy: { discountPercent: 'asc' } });
  return jsonOk({ items });
});
