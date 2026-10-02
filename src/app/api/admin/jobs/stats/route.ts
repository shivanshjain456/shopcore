/**
 * GET /api/admin/jobs/stats — queue-health summary.
 *
 *   Returns counts by status, the oldest PENDING job timestamp (helps
 *   diagnose runner-stuck conditions), and a rolling-window average
 *   completion time (over the last 100 COMPLETED jobs — enough to be
 *   indicative without blowing out the response).
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();

  const [
    pending, processing, completed, failed, cancelled,
    oldest, recentCompleted,
  ] = await Promise.all([
    prisma.job.count({ where: { status: 'PENDING'    } }),
    prisma.job.count({ where: { status: 'PROCESSING' } }),
    prisma.job.count({ where: { status: 'COMPLETED'  } }),
    prisma.job.count({ where: { status: 'FAILED'     } }),
    prisma.job.count({ where: { status: 'CANCELLED'  } }),
    prisma.job.findFirst({
      where: { status: 'PENDING' },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
    prisma.job.findMany({
      where: { status: 'COMPLETED', startedAt: { not: null }, completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      take: 100,
      select: { startedAt: true, completedAt: true },
    }),
  ]);

  const durations: number[] = [];
  for (const r of recentCompleted) {
    if (r.startedAt && r.completedAt) {
      durations.push(r.completedAt.getTime() - r.startedAt.getTime());
    }
  }
  const avgCompletionMs = durations.length === 0
    ? null
    : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  return jsonOk({
    pending, processing, completed, failed, cancelled,
    oldestPending: oldest ? oldest.runAt.toISOString() : null,
    avgCompletionMs,
    avgWindow:     durations.length,   // # of samples averaged
  });
});
