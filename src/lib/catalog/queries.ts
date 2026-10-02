/**
 * Catalog query helpers. Centralised so any page/API shares the same logic.
 */
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';

export interface ListProductsParams {
  categorySlug?: string;
  brandSlugs?: string[];
  q?: string;                  // free-text search
  minPaise?: number;
  maxPaise?: number;
  inStockOnly?: boolean;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'name';
  page?: number;
  pageSize?: number;
}

export interface ListProductsResult {
  items: Awaited<ReturnType<typeof fetchProducts>>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

async function fetchProducts(where: Prisma.ProductWhereInput, orderBy: Prisma.ProductOrderByWithRelationInput, skip: number, take: number) {
  return prisma.product.findMany({
    where, orderBy, skip, take,
    include: {
      category: { select: { name: true, slug: true } },
      brand:    { select: { name: true, slug: true } },
      images:   { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      variants: { where: { isActive: true }, select: { id: true, stock: true } },
    },
  });
}

export async function listProducts(params: ListProductsParams): Promise<ListProductsResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(60, Math.max(1, params.pageSize ?? 24));

  const where: Prisma.ProductWhereInput = { isActive: true };

  if (params.categorySlug) {
    where.category = { slug: params.categorySlug };
  }
  if (params.brandSlugs && params.brandSlugs.length > 0) {
    where.brand = { slug: { in: params.brandSlugs } };
  }
  if (params.minPaise !== undefined || params.maxPaise !== undefined) {
    where.pricePaise = {
      ...(params.minPaise !== undefined ? { gte: params.minPaise } : {}),
      ...(params.maxPaise !== undefined ? { lte: params.maxPaise } : {}),
    };
  }
  if (params.q && params.q.trim()) {
    // SQLite LIKE with case-insensitive collation handled at app layer:
    const tokens = params.q.trim().toLowerCase().split(/\s+/).slice(0, 6);
    where.AND = tokens.map((t) => ({
      OR: [
        { name:        { contains: t } },
        { description: { contains: t } },
        { shortDesc:   { contains: t } },
        { sku:         { contains: t } },
        { aiTags:      { contains: t } },
        { brand: { name: { contains: t } } },
        { category: { name: { contains: t } } },
      ],
    }));
  }
  if (params.inStockOnly) {
    where.OR = [{ stock: { gt: 0 } }, { variants: { some: { stock: { gt: 0 }, isActive: true } } }];
  }

  let orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };
  switch (params.sort) {
    case 'price_asc':  orderBy = { pricePaise: 'asc' }; break;
    case 'price_desc': orderBy = { pricePaise: 'desc' }; break;
    case 'newest':     orderBy = { createdAt: 'desc' }; break;
    case 'name':       orderBy = { name: 'asc' }; break;
    case 'relevance':
    default:
      orderBy = params.q ? { isFeatured: 'desc' } : { isFeatured: 'desc' };
  }

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    fetchProducts(where, orderBy, (page - 1) * pageSize, pageSize),
  ]);

  return {
    items, total, page, pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getProductBySlug(slug: string) {
  return prisma.product.findUnique({
    where: { slug },
    include: {
      category: true,
      brand: true,
      // Item 19 — PDP gallery: ACTIVE images only, primary first then
      // by sortOrder so the gallery component receives them in display
      // order without re-sorting.
      images:   {
        where: { isActive: true },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      variants: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
      reviews:  {
        where: { isApproved: true },
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
}

export async function getRelatedProducts(productId: string, categoryId: string, limit = 8) {
  return prisma.product.findMany({
    where: {
      isActive: true,
      id: { not: productId },
      categoryId,
    },
    take: limit,
    orderBy: { isFeatured: 'desc' },
    include: {
      images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      brand:  { select: { name: true, slug: true } },
    },
  });
}

export async function getCategoriesWithCounts() {
  // Prisma's _count filter requires v4.0+; we use a two-step approach for safety.
  const cats = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  const counts = await prisma.product.groupBy({
    by: ['categoryId'],
    _count: { _all: true },
    where: { isActive: true },
  });
  const countByCat = Object.fromEntries(counts.map((c) => [c.categoryId, c._count._all]));
  return cats.map((c) => ({ ...c, _count: { products: countByCat[c.id] ?? 0 } }));
}

export async function getBrands() {
  // PAGINATION-EXEMPT: brands table is a small lookup (typically < 100
  // active rows). Used by filter chips + the homepage brand band.
  return prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
}

export async function getFeaturedProducts(limit = 8) {
  return prisma.product.findMany({
    where: { isActive: true, isFeatured: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      images:   { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      category: { select: { name: true, slug: true } },
      brand:    { select: { name: true, slug: true } },
    },
  });
}
