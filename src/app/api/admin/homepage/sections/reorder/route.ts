/**
 * POST /api/admin/homepage/sections/reorder — atomic reorder.
 *   Body: { orderedIds: string[] }
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { reorderSections } from '@/lib/cms/homepage';

export const dynamic = 'force-dynamic';

const Body = z.object({
  orderedIds: z.array(z.string().min(1).max(64)).min(0).max(64),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const { orderedIds } = Body.parse(await req.json());
  await reorderSections(orderedIds);
  await audit({
    actorId: admin.id, action: 'HOMEPAGE_SECTION_REORDER',
    entity: 'HomepageSection', entityId: 'all',
    after: { orderedIds },
  });
  return jsonOk({ ok: true });
});
