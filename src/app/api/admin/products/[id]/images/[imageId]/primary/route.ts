/**
 * POST /api/admin/products/[id]/images/[imageId]/primary
 *   Marks this image as the product's primary image. Exactly-one-
 *   primary invariant is enforced inside a transaction. Audits
 *   `PRODUCT_IMAGE_PRIMARY_CHANGED`.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { setPrimary } from '@/lib/cms/productGallery';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (
  _req: NextRequest,
  { params }: { params: { id: string; imageId: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const target = await prisma.productImage.findUnique({ where: { id: params.imageId } });
  if (!target || target.productId !== params.id) {
    return jsonError('Image not found for this product.', 404);
  }
  const wasPrimary = target.isPrimary;
  const updated = await setPrimary(params.id, params.imageId);

  await audit({
    actorId: admin.id, action: 'PRODUCT_IMAGE_PRIMARY_CHANGED',
    entity: 'Product', entityId: params.id,
    before: { previousPrimaryImageId: await previousPrimaryId(params.id, params.imageId), thisWasPrimary: wasPrimary },
    after:  { primaryImageId: updated.id },
  });
  return jsonOk({ image: updated });
});

/** Look up the image that WAS primary just before this swap (best-effort
 *  audit context — null if there wasn't one). */
async function previousPrimaryId(productId: string, exceptId: string): Promise<string | null> {
  const r = await prisma.productImage.findFirst({
    where: { productId, isPrimary: true, NOT: { id: exceptId } },
    select: { id: true },
  });
  return r?.id ?? null;
}
