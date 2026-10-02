/**
 * PATCH /api/admin/job-schedules/[id] — toggle isActive, update cron.
 *
 *   Body (all fields optional, at least one required):
 *     { isActive?: boolean, cronExpression?: string }
 *
 *   When `cronExpression` changes we re-parse + recompute `nextRunAt` so
 *   the scheduler picks the row up on its new cadence. A bad cron is
 *   rejected synchronously (ValidationError → 400) — the table never
 *   stores an unparseable expression.
 *
 *   Writes audit log: action='JOB_SCHEDULE_UPDATE'.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { computeNextRun } from '@/lib/jobs/cronParser';
import { toScheduleRow } from '@/lib/jobs/adminSerializers';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  isActive:       z.boolean().optional(),
  cronExpression: z.string().min(3).max(64).optional(),
}).refine(
  (v) => v.isActive !== undefined || v.cronExpression !== undefined,
  { message: 'At least one of isActive or cronExpression is required.' },
);

export const PATCH = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const before = await prisma.jobSchedule.findUnique({ where: { id: params.id } });
  if (!before) return jsonError('Schedule not found.', 404, { code: 'NOT_FOUND' });

  const body = PatchSchema.parse(await req.json());
  const data: { isActive?: boolean; cronExpression?: string; nextRunAt?: Date } = {};
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.cronExpression !== undefined) {
    // Throws ValidationError(INVALID_CRON) on bad expression — surfaces
    // as 400 with field-level message via withErrorHandling.
    data.nextRunAt = computeNextRun(body.cronExpression, new Date());
    data.cronExpression = body.cronExpression;
  }

  const after = await prisma.jobSchedule.update({
    where: { id: params.id },
    data,
  });

  await audit({
    actorId:  admin.id,
    action:   'JOB_SCHEDULE_UPDATE',
    entity:   'JobSchedule',
    entityId: params.id,
    before:   { isActive: before.isActive, cronExpression: before.cronExpression, nextRunAt: before.nextRunAt },
    after:    { isActive: after.isActive,  cronExpression: after.cronExpression,  nextRunAt: after.nextRunAt  },
  });

  return jsonOk({ schedule: toScheduleRow(after) });
});
