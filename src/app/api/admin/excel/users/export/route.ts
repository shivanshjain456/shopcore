import type { NextRequest } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { NextResponse } from 'next/server';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { exportUsersXlsx, exportUsersCsv } from '@/lib/admin/excel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  try {
    const admin = await requireAdminUser();
    const fmt = (req.nextUrl.searchParams.get('format') ?? 'xlsx').toLowerCase();
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      const csv = await exportUsersCsv();
      await audit({ actorId: admin.id, action: 'EXPORT_USERS_CSV', entity: 'User' });
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="shopcore-users-${stamp}.csv"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }
    const buf = await exportUsersXlsx();
    await audit({ actorId: admin.id, action: 'EXPORT_USERS_XLSX', entity: 'User' });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="shopcore-users-${stamp}.xlsx"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (e instanceof AdminGuardError) return e.response;
    throw e;
  }
});
