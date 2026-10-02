/**
 * GET /api/ready — readiness probe.
 *
 * Returns 200 only when:
 *   - SQLite is reachable + responds to a trivial query
 *   - StoreConfig singleton exists (i.e. seed has run)
 *   - Production-safety checks pass (or NODE_ENV !== 'production')
 *
 * 503 otherwise with a `problems[]` array (no secret data leaked).
 */
import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { prisma } from '@/lib/db/client';
import { checkProductionSafety } from '@/lib/boot';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const problems: string[] = [];
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    problems.push('Database unreachable.');
  }

  let configured = false;
  if (dbOk) {
    try {
      const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
      configured = !!row;
      if (!configured) problems.push('StoreConfig singleton missing — run `npm run db:seed`.');
    } catch {
      problems.push('StoreConfig table not found — run `npm run db:migrate`.');
    }
  }

  const safety = checkProductionSafety();
  // In production, surface safety problems too
  if (env.NODE_ENV === 'production' && !safety.ok) problems.push(...safety.problems);

  const ok = problems.length === 0;
  return NextResponse.json({ ok, dbOk, configured, env: env.NODE_ENV, problems }, { status: ok ? 200 : 503 });
});
