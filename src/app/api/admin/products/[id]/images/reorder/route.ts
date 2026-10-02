/**
 * POST /api/admin/products/[id]/images/reorder
 *   Body: { orderedIds: string[] }
 *
 *   Atomically renumbers `sortOrder` (10 / 20 / 30 / …) so the
 *   storefront sees the new order on the next read. Unknown IDs are
 *   silently dropped; missing IDs slide to the tail. Audits
 *   `PRODUCT_IMAGE_REORDER`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { reorderImages, listGalleryForAdmin } from '@/lib/cms/productGallery';

export const dynamic = 'force-dynamic';

const Body = z.object({
  orderedIds: z.array(z.string().min(1).max(64)).max(40),
});

export const POST = withErrorHandling(async (
  req: NextRequest, { params }: { params: { id: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const product = await prisma.product.findUnique({
    where: { id: params.id }, select: { id: true },
  });
  if (!product) return jsonError('Product not found.', 404);

  const body = Body.parse(await req.json());
  const before = await listGalleryForAdmin(params.id);
  await reorderImages(params.id, body.orderedIds);
  const after = await listGalleryForAdmin(params.id);

  await audit({
    actorId: admin.id, action: 'PRODUCT_IMAGE_REORDER',
    entity: 'Product', entityId: params.id,
    before: before.map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
    after:  after.map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
  });
  return jsonOk({ items: after });
});
