import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { importProductsXlsx } from '@/lib/admin/excel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) return jsonError('No file uploaded.', 400);
  if (f.size > 25 * 1024 * 1024) return jsonError('File too large (max 25 MB).', 400);
  const buf = Buffer.from(await f.arrayBuffer());
  const result = await importProductsXlsx(buf);
  await audit({
    actorId: admin.id, action: 'IMPORT_PRODUCTS_XLSX', entity: 'Product',
    after: {
      products: { ok: result.products.filter((r) => r.ok).length, failed: result.products.filter((r) => !r.ok).length },
      variants: { ok: result.variants.filter((r) => r.ok).length, failed: result.variants.filter((r) => !r.ok).length },
    },
  });
  return jsonOk({
    summary: {
      products: { ok: result.products.filter((r) => r.ok).length, failed: result.products.filter((r) => !r.ok).length },
      variants: { ok: result.variants.filter((r) => r.ok).length, failed: result.variants.filter((r) => !r.ok).length },
    },
    ...result,
  });
});
