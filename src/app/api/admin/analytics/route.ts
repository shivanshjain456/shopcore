import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { computeKpis } from '@/lib/admin/analytics';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  const data = await computeKpis();
  return jsonOk(data);
});
