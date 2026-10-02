import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { importInventoryXlsx } from '@/lib/admin/excel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) return jsonError('No file uploaded.', 400);
  const mode = (form.get('mode') as string) === 'delta' ? 'delta' : 'absolute';
  if (f.size > 10 * 1024 * 1024) return jsonError('File too large (max 10 MB).', 400);
  const buf = Buffer.from(await f.arrayBuffer());
  const rows = await importInventoryXlsx(buf, mode, admin.id);
  await audit({
    actorId: admin.id, action: 'IMPORT_INVENTORY_XLSX', entity: 'Inventory',
    after: { mode, ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length },
  });
  return jsonOk({
    summary: { ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length, total: rows.length },
    rows,
  });
});
