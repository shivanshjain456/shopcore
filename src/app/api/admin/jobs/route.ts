/**
 * GET /api/admin/jobs — paginated, filterable list of job rows.
 *
 *   Query params (all optional):
 *     status      one of PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED
 *     type        a JobType string (validated against JOB_TYPES)
 *     queueName   logical queue (default 'default')
 *     page        1-based page index; default 1
 *     pageSize    rows per page; default 25, capped at 100
 *
 *   Returns:
 *     { items: JobRow[], total, page, pageSize, pageCount }
 *
 *   PII / payload exposure: the payload is parsed and returned as-is for
 *   admins. SEND_EMAIL payloads contain raw email addresses — admins
 *   can already see customer emails in /admin/customers, so this is
 *   policy-consistent (documented in spec §3.10 + this file).
 */
import type { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { isJobType } from '@/lib/jobs/jobTypes';
import { toJobRow } from '@/lib/jobs/adminSerializers';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES = new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']);

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;

  const status    = sp.get('status');
  const type      = sp.get('type');
  const queueName = sp.get('queueName');
  // Item 12 — canonical pagination utilities.
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, {
    defaultPageSize: 20,
  });

  const where: Prisma.JobWhereInput = {};
  if (status && ALLOWED_STATUSES.has(status))   where.status    = status;
  if (type && isJobType(type))                  where.type      = type;
  if (queueName)                                where.queueName = queueName;

  const [total, items] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where,
      // Newest first — operators are typically debugging the most recent
      // failure or watching the live queue.
      orderBy: [{ createdAt: 'desc' }],
      skip, take,
    }),
  ]);

  return jsonOk(buildPagination(items.map(toJobRow), total, page, pageSize));
});
