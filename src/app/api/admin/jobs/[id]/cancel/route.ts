/**
 * POST /api/admin/jobs/[id]/cancel — cancel a PENDING job.
 *
 *   Only PENDING jobs are cancellable. A PROCESSING job is already
 *   in-flight — the safe move is to wait for it to settle (the runner
 *   will mark it COMPLETED or FAILED on its own). COMPLETED / FAILED /
 *   CANCELLED rows refuse a second transition.
 *
 *   Writes audit log entry: action='JOB_CANCEL', entity='Job'.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { toJobDetail } from '@/lib/jobs/adminSerializers';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (
  _req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const before = await prisma.job.findUnique({ where: { id: params.id } });
  if (!before) return jsonError('Job not found.', 404, { code: 'NOT_FOUND' });
  if (before.status !== 'PENDING') {
    return jsonError(
      `Only PENDING jobs can be cancelled (current status: ${before.status}).`,
      409,
      { code: 'JOB_NOT_CANCELLABLE' },
    );
  }

  // Atomic guard: another runner could claim this row between our
  // findUnique and update. The WHERE status='PENDING' makes the cancel a
  // single SQL UPDATE that either wins the race (1 row) or loses (0 rows).
  const res = await prisma.job.updateMany({
    where: { id: params.id, status: 'PENDING' },
    data:  { status: 'CANCELLED' },
  });
  if (res.count === 0) {
    return jsonError(
      'Job was claimed by the runner before we could cancel it.',
      409,
      { code: 'JOB_NOT_CANCELLABLE' },
    );
  }

  const after = await prisma.job.findUnique({ where: { id: params.id } });
  await audit({
    actorId:  admin.id,
    action:   'JOB_CANCEL',
    entity:   'Job',
    entityId: params.id,
    before:   { status: before.status },
    after:    { status: 'CANCELLED' },
  });

  return jsonOk({ job: after ? toJobDetail(after) : null });
});
