/** GET /api/admin/products?q=&page=&pageSize=&category=&brand=  + POST create. */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdminUser();
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') ?? '').trim();
  // Item 12 — config-driven pagination via the canonical helper. The
  // helper validates / clamps / throws ValidationError for bad inputs.
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(sp, config, {
    defaultPageSize: 20,
  });
  const where: Prisma.ProductWhereInput = {};
  if (q) where.OR = [
    { name: { contains: q } }, { sku: { contains: q } },
    { description: { contains: q } }, { brand: { name: { contains: q } } },
  ];
  if (sp.get('category')) where.category = { slug: sp.get('category')! };
  if (sp.get('brand'))    where.brand    = { slug: sp.get('brand')! };

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip, take,
      include: { category: true, brand: true, _count: { select: { variants: true, orderItems: true } } },
    }),
  ]);
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const CreateBody = z.object({
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().optional(),
  description: z.string().trim().max(20_000).default(''),
  shortDesc: z.string().trim().max(500).optional().nullable(),
  categorySlug: z.string().trim().min(1),
  brandSlug: z.string().trim().optional().nullable(),
  mrpPaise: z.number().int().min(0),
  pricePaise: z.number().int().min(0),
  b2bPricePaise: z.number().int().min(0).optional().nullable(),
  stock: z.number().int().min(0).default(0),
  lowStockAt: z.number().int().min(0).default(5),
  gstRate: z.number().min(0).max(28).default(18),
  hsnCode: z.string().trim().max(20).optional().nullable(),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  aiTags: z.string().trim().max(500).optional().nullable(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = CreateBody.parse(await req.json());
  const cat = await prisma.category.findUnique({ where: { slug: body.categorySlug } });
  if (!cat) return jsonError('Category not found.', 400);
  let brandId: string | null = null;
  if (body.brandSlug) {
    const br = await prisma.brand.findUnique({ where: { slug: body.brandSlug } });
    if (!br) return jsonError('Brand not found.', 400);
    brandId = br.id;
  }
  const slug = body.slug?.trim() ? slugify(body.slug) : slugify(body.name);

  const p = await prisma.product.create({
    data: {
      sku: body.sku.toUpperCase(), name: body.name, slug, description: body.description, shortDesc: body.shortDesc ?? null,
      categoryId: cat.id, brandId,
      mrpPaise: body.mrpPaise, pricePaise: body.pricePaise, b2bPricePaise: body.b2bPricePaise ?? null,
      stock: body.stock, lowStockAt: body.lowStockAt,
      gstRate: body.gstRate, hsnCode: body.hsnCode ?? null,
      isActive: body.isActive, isFeatured: body.isFeatured,
      aiTags: body.aiTags ?? null,
    },
  });
  await audit({ actorId: admin.id, action: 'PRODUCT_CREATE', entity: 'Product', entityId: p.id, after: p });
  return jsonOk({ product: p });
});
