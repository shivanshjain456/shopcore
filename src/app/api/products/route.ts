import type { NextRequest } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { listProducts } from '@/lib/catalog/queries';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  // Item 12 — canonical paginator. Storefront product grid keeps its
  // 24/page default (the grid is 4×6 on desktop); the global store
  // config cap still applies.
  const config = await getStoreConfig();
  const { page, pageSize } = parsePaginationParams(sp, config, { defaultPageSize: 24 });
  const result = await listProducts({
    q: sp.get('q') ?? undefined,
    categorySlug: sp.get('category') ?? undefined,
    brandSlugs: (sp.get('brand') ?? '').split(',').filter(Boolean),
    minPaise: sp.get('min') ? Number(sp.get('min')) : undefined,
    maxPaise: sp.get('max') ? Number(sp.get('max')) : undefined,
    sort: (sp.get('sort') as 'price_asc' | 'price_desc' | 'newest' | 'name' | 'relevance' | null) ?? 'relevance',
    inStockOnly: sp.get('instock') === '1',
    page,
    pageSize,
  });
  const items = result.items.map((p) => ({
    id: p.id, sku: p.sku, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
    mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
    stock: p.stock,
    imageUrl: p.images[0]?.url ?? null,
    category: p.category, brand: p.brand,
    hasVariants: p.variants.length > 0,
  }));
  // Item 12 — standard envelope. The legacy `pageCount` is gone;
  // callers should use `pagination.totalPages`.
  return jsonOk(buildPagination(items, result.total, result.page, result.pageSize));
});
