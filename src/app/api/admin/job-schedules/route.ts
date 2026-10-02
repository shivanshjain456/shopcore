/**
 * GET /api/admin/job-schedules — list every recurring schedule.
 *
 *   Returns all rows (no pagination — the list is small + bounded by
 *   BUILT_IN_SCHEDULES). Sorted by name for stable UI rendering.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { toScheduleRow } from '@/lib/jobs/adminSerializers';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  // PAGINATION-EXEMPT: schedules are a small ops table (a handful of rows).
  const items = await prisma.jobSchedule.findMany({ orderBy: { name: 'asc' } });
  return jsonOk({ items: items.map(toScheduleRow) });
});
