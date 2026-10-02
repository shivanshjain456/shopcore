/** GET / PATCH / DELETE single product. */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(20_000).optional(),
  shortDesc: z.string().trim().max(500).nullable().optional(),
  categorySlug: z.string().trim().optional(),
  brandSlug: z.string().trim().nullable().optional(),
  mrpPaise: z.number().int().min(0).optional(),
  pricePaise: z.number().int().min(0).optional(),
  b2bPricePaise: z.number().int().min(0).nullable().optional(),
  stock: z.number().int().min(0).optional(),
  lowStockAt: z.number().int().min(0).optional(),
  gstRate: z.number().min(0).max(28).optional(),
  hsnCode: z.string().trim().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  aiTags: z.string().trim().max(500).nullable().optional(),
});

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const p = await prisma.product.findUnique({
    where: { id: params.id },
    include: { category: true, brand: true, variants: { orderBy: { createdAt: 'asc' } }, images: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!p) return jsonError('Not found.', 404);
  return jsonOk({ product: p });
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = PatchBody.parse(await req.json());
  const existing = await prisma.product.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);

  const data: Record<string, unknown> = { ...body };
  if (body.categorySlug !== undefined) {
    const c = await prisma.category.findUnique({ where: { slug: body.categorySlug } });
    if (!c) return jsonError('Category not found.', 400);
    data.categoryId = c.id; delete data.categorySlug;
  }
  if (body.brandSlug !== undefined) {
    if (body.brandSlug === null) data.brandId = null;
    else {
      const b = await prisma.brand.findUnique({ where: { slug: body.brandSlug } });
      if (!b) return jsonError('Brand not found.', 400);
      data.brandId = b.id;
    }
    delete data.brandSlug;
  }
  const updated = await prisma.product.update({ where: { id: params.id }, data });

  // If stock changed via this endpoint, log it
  if (body.stock !== undefined && body.stock !== existing.stock) {
    await prisma.inventoryLog.create({
      data: { productId: existing.id, delta: body.stock - existing.stock, reason: 'MANUAL_ADJUST', performedBy: admin.id },
    });
  }
  await audit({ actorId: admin.id, action: 'PRODUCT_UPDATE', entity: 'Product', entityId: existing.id, before: existing, after: updated });
  return jsonOk({ product: updated });
});

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const existing = await prisma.product.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  // Refuse delete if used in any order; soft-delete via isActive=false instead
  const used = await prisma.orderItem.count({ where: { productId: existing.id } });
  if (used > 0) {
    await prisma.product.update({ where: { id: existing.id }, data: { isActive: false } });
    await audit({ actorId: admin.id, action: 'PRODUCT_DEACTIVATE', entity: 'Product', entityId: existing.id, before: existing });
    return jsonOk({ deactivated: true });
  }
  await prisma.product.delete({ where: { id: existing.id } });
  await audit({ actorId: admin.id, action: 'PRODUCT_DELETE', entity: 'Product', entityId: existing.id, before: existing });
  return jsonOk({ deleted: true });
});
