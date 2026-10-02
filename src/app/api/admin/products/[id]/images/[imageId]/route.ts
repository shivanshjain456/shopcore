/**
 * PATCH  /api/admin/products/[id]/images/[imageId]
 *   Body: { alt?, isActive?, sortOrder? }
 *
 * DELETE /api/admin/products/[id]/images/[imageId]
 *   Idempotent. If the deleted row was primary, the next active image
 *   is promoted by the service layer (`ensurePrimary`).
 *
 * Both audit to `PRODUCT_IMAGE_UPDATE` / `PRODUCT_IMAGE_DELETE`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { updateImage, deleteImage } from '@/lib/cms/productGallery';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  alt:       z.string().trim().max(200).nullable().optional(),
  isActive:  z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const PATCH = withErrorHandling(async (
  req: NextRequest,
  { params }: { params: { id: string; imageId: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const existing = await prisma.productImage.findUnique({ where: { id: params.imageId } });
  if (!existing || existing.productId !== params.id) {
    return jsonError('Image not found for this product.', 404);
  }

  const body = PatchBody.parse(await req.json());
  const updated = await updateImage(params.imageId, body);
  await audit({
    actorId: admin.id, action: 'PRODUCT_IMAGE_UPDATE',
    entity: 'ProductImage', entityId: updated.id,
    before: { alt: existing.alt, isActive: existing.isActive, sortOrder: existing.sortOrder },
    after:  { alt: updated.alt,  isActive: updated.isActive,  sortOrder: updated.sortOrder  },
  });
  return jsonOk({ image: updated });
});

export const DELETE = withErrorHandling(async (
  _req: NextRequest,
  { params }: { params: { id: string; imageId: string } },
) => {
  assertCsrf();
  const admin = await requireAdminUser();

  const existing = await prisma.productImage.findUnique({ where: { id: params.imageId } });
  if (!existing || existing.productId !== params.id) {
    // Idempotent delete: 200 with `{ deleted: false }` so re-runs are safe.
    return jsonOk({ deleted: false });
  }
  await deleteImage(params.imageId);
  await audit({
    actorId: admin.id, action: 'PRODUCT_IMAGE_DELETE',
    entity: 'ProductImage', entityId: existing.id,
    before: { url: existing.url, isPrimary: existing.isPrimary, sortOrder: existing.sortOrder },
  });
  return jsonOk({ deleted: true });
});
