/**
 * GET  /api/admin/homepage/metrics — list trust-metric tiles.
 * POST /api/admin/homepage/metrics — create a metric.
 */
import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { listMetricsForAdmin, upsertMetric } from '@/lib/cms/homepage';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  return jsonOk({ items: await listMetricsForAdmin() });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = await req.json() as Record<string, unknown>;
  const row = await upsertMetric(null, {
    label:        String(body.label ?? ''),
    value:        String(body.value ?? ''),
    caption:      (body.caption as string | null | undefined) ?? null,
    iconUrl:      (body.iconUrl as string | null | undefined) ?? null,
    displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : undefined,
    isActive:     body.isActive === undefined ? undefined : !!body.isActive,
  });
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_METRIC_UPDATE',
    entity: 'HomepageMetric', entityId: row.id, after: row,
  });
  return jsonOk({ metric: row });
});
