/**
 * POST /api/admin/jobs/[id]/retry — manually requeue a FAILED job.
 *
 *   Resets:  status='PENDING', attempts=0, runAt=now, error=null, failedAt=null,
 *            lockToken=null, lockExpiresAt=null
 *   Refuses any other status (only FAILED is retryable — PENDING jobs are
 *   already eligible, CANCELLED jobs were deliberately stopped).
 *
 *   Writes audit log entry: action='JOB_RETRY', entity='Job'.
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
  if (before.status !== 'FAILED') {
    return jsonError(
      `Only FAILED jobs can be retried (current status: ${before.status}).`,
      409,
      { code: 'JOB_NOT_RETRYABLE' },
    );
  }

  const updated = await prisma.job.update({
    where: { id: params.id },
    data: {
      status:        'PENDING',
      attempts:      0,
      runAt:         new Date(),
      failedAt:      null,
      error:         null,
      lockToken:     null,
      lockExpiresAt: null,
    },
  });

  await audit({
    actorId:  admin.id,
    action:   'JOB_RETRY',
    entity:   'Job',
    entityId: updated.id,
    before:   { status: before.status, attempts: before.attempts, failedAt: before.failedAt },
    after:    { status: updated.status, attempts: updated.attempts, runAt: updated.runAt },
  });

  return jsonOk({ job: toJobDetail(updated) });
});
