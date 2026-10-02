/**
 * POST /api/admin/store-config/export
 *
 * Returns the current unified config as a downloadable JSON file with
 * `Content-Disposition: attachment` set. Method is POST (not GET) to
 * keep the action out of cacheable proxies and bound by CSRF — we
 * audit every export so a stolen admin cookie can be traced.
 */
import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { log } from '@/lib/log';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async () => {
  assertCsrf();
  const admin = await requireAdminUser();
  const config = await getStoreConfig();

  await audit({
    actorId:  admin.id,
    action:   'STORE_CONFIG_EXPORTED',
    entity:   'StoreConfig',
    entityId: 'singleton',
  });
  log.info('config.exported', { adminId: admin.id });

  const filename = `shopcore-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  return new NextResponse(JSON.stringify(config, null, 2), {
    status: 200,
    headers: {
      'Content-Type':        'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Belt-and-braces: never let an exported config sit in a CDN.
      'Cache-Control':       'no-store, no-cache, must-revalidate, private',
    },
  });
});
