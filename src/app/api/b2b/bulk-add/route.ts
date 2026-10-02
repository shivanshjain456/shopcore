import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { parseBulkCsv, bulkAddToCart } from '@/lib/b2b/bulk';
import { requireB2BEnabled } from '@/lib/storeConfig/featureGate';

export const dynamic = 'force-dynamic';

const Body = z.object({
  csv:  z.string().trim().min(1).max(50_000).optional(),
  rows: z.array(z.object({ sku: z.string().trim().min(1), qty: z.number().int().min(1).max(1000) })).max(500).optional(),
}).refine((d) => !!d.csv || !!d.rows, { message: 'Provide csv or rows.' });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireB2BEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  if (user.role !== 'B2B' || !user.b2bApprovedAt) return jsonError('B2B account required.', 403);

  const body = Body.parse(await req.json());
  const rows = body.rows ?? parseBulkCsv(body.csv!);
  if (rows.length === 0) return jsonError('No valid rows found.', 400);

  const results = await bulkAddToCart(user.id, rows);
  const summary = {
    total: results.length,
    added: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  return jsonOk({ summary, results });
});
