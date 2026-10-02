/**
 * GET  /api/admin/products/[id]/images
 *   Lists every gallery row for a product (including inactive ones).
 *   Admin-only.
 *
 * POST /api/admin/products/[id]/images
 *   multipart/form-data: file=<binary> alt=<string?>
 *   ── OR ──
 *   JSON body: { url, alt? }
 *     (URL registration only — useful for paste-URL flows; the file
 *      upload path uses the multipart variant which routes through
 *      saveAdminImage so EXIF / dimensions / sharp re-encode happen.)
 *
 *   Admin-only. CSRF + admin-uploads rate limit + audit
 *   (`PRODUCT_IMAGE_UPLOAD`).
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, audit } from '@/lib/admin/guards';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { prisma } from '@/lib/db/client';
import { saveAdminImage } from '@/lib/uploads/adminImages';
import { listGalleryForAdmin, registerImage } from '@/lib/cms/productGallery';
import { getStoreConfig } from '@/lib/storeConfig';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const product = await prisma.product.findUnique({
    where: { id: params.id }, select: { id: true, name: true, slug: true },
  });
  if (!product) return jsonError('Product not found.', 404);
  const [items, cfg] = await Promise.all([
    listGalleryForAdmin(params.id),
    getStoreConfig(),
  ]);
  const products = (cfg as unknown as { products?: { maxGalleryImages?: number; galleryEnabled?: boolean } }).products ?? {};
  const maxImages = Math.max(1, Math.min(40, Math.floor(products.maxGalleryImages ?? 12)));
  const galleryEnabled = products.galleryEnabled !== false;
  return jsonOk({ product, items, maxImages, galleryEnabled });
});

const RegisterUrlBody = z.object({
  url: z.string().trim().min(1).max(500),
  alt: z.string().trim().max(200).optional().nullable(),
});

export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  await applyRateLimit('admin.uploads', req, { userId: admin.id });

  const product = await prisma.product.findUnique({
    where: { id: params.id }, select: { id: true, name: true },
  });
  if (!product) return jsonError('Product not found.', 404);

  const contentType = req.headers.get('content-type') ?? '';

  // ── Multipart: upload + register in one go.
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const f = form.get('file');
    if (!(f instanceof File)) return jsonError('No file uploaded.', 400);
    const altRaw = form.get('alt');
    const alt = typeof altRaw === 'string' ? altRaw : null;

    const saved = await saveAdminImage({ kind: 'product', file: f });
    if (!saved.ok) return jsonError(saved.reason, 400);

    // Record the StoreAsset row for the global asset registry
    // (consistent with how /admin/uploads behaves for other kinds).
    try {
      await prisma.storeAsset.create({
        data: {
          kind: 'product',
          url:  saved.data.url,
          altText: alt ?? product.name,
          width:  saved.data.width,
          height: saved.data.height,
          mimeType: saved.data.mime,
          bytes:    saved.data.bytes,
          uploadedBy: admin.id,
        },
      });
    } catch (e) {
      // StoreAsset is for the central registry — a duplicate URL or
      // any other registry issue must NOT block the gallery write.
      log.warn('product.image.store_asset_skip', {
        productId: params.id, url: saved.data.url, err: (e as Error).message,
      });
    }

    const row = await registerImage({
      productId: params.id, url: saved.data.url, alt: alt ?? product.name,
    });
    await audit({
      actorId: admin.id, action: 'PRODUCT_IMAGE_UPLOAD',
      entity: 'ProductImage', entityId: row.id,
      after: { productId: row.productId, url: row.url, sortOrder: row.sortOrder, isPrimary: row.isPrimary },
    });
    return jsonOk({ image: row });
  }

  // ── JSON: register an externally-hosted URL.
  const body = RegisterUrlBody.parse(await req.json());
  const row = await registerImage({
    productId: params.id, url: body.url, alt: body.alt ?? null,
  });
  await audit({
    actorId: admin.id, action: 'PRODUCT_IMAGE_UPLOAD',
    entity: 'ProductImage', entityId: row.id,
    after: { productId: row.productId, url: row.url, sortOrder: row.sortOrder, isPrimary: row.isPrimary },
  });
  return jsonOk({ image: row });
});
