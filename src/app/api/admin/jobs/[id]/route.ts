/**
 * GET /api/admin/jobs/[id] — full job detail (payload + result + lock).
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { toJobDetail } from '@/lib/jobs/adminSerializers';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_req: NextRequest, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const job = await prisma.job.findUnique({ where: { id: params.id } });
  if (!job) return jsonError('Job not found.', 404, { code: 'NOT_FOUND' });
  return jsonOk({ job: toJobDetail(job) });
});
