import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { exportProductsXlsx } from '@/lib/admin/excel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withErrorHandling(async () => {
  try {
    const admin = await requireAdminUser();
    const buf = await exportProductsXlsx();
    await audit({ actorId: admin.id, action: 'EXPORT_PRODUCTS_XLSX', entity: 'Product' });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="shopcore-products-${new Date().toISOString().slice(0,10)}.xlsx"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (e instanceof AdminGuardError) return e.response;
    throw e;
  }
});
