/**
 * Compare data aggregator — Item 14.
 *
 * Single Prisma read that returns everything the /compare page needs
 * for one product. Used both by the server-rendered page and by the
 * share-URL view.
 *
 * Why one function:
 *   - Keeps the query shape consistent (no drift between page-load and
 *     share-URL paths).
 *   - One round-trip per call site (page = one batched `findMany`,
 *     share view = same).
 *   - Easy to extend: adding a new column means one place to edit.
 */
import { prisma } from '@/lib/db/client';
import { discountPercent, rupees } from '@/lib/catalog/pricing';
import { parseAttributes } from './attributeKeyResolver';

export interface CompareProduct {
  id:            string;
  slug:          string;
  sku:           string;
  name:          string;
  shortDesc:     string | null;
  brand:         { name: string; slug: string } | null;
  category:      { name: string; slug: string };
  imageUrl:      string | null;
  mrpPaise:      number;
  pricePaise:    number;
  b2bPricePaise: number | null;
  gstRate:       number;
  hsnCode:       string | null;
  stock:         number;
  lowStockAt:    number;
  /** Parsed attributes JSON. Empty object if missing / malformed. */
  attributes:    Record<string, unknown>;
  /** Pre-formatted INR strings the UI uses directly. */
  display: {
    mrp:              string;
    price:            string;
    discountPercent:  number;
    stockStatus:      'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
  };
  variants: Array<{
    id:           string;
    name:         string;
    attributes:   Record<string, unknown>;
    pricePaise:   number;
    stock:        number;
  }>;
  reviews: {
    averageRating: number;        // 0–5; 0 when no reviews yet
    count:         number;
    /** Distribution percentages — 0–100, sum ≤ 100 (round-off). */
    distribution:  { 1: number; 2: number; 3: number; 4: number; 5: number };
  };
}

/** Server-side fetch of N products in the order of their ids.
 *  Quietly drops inactive / unknown ids so the page can show
 *  "no longer available" placeholders for them. */
export async function fetchCompareProducts(productIds: string[]): Promise<CompareProduct[]> {
  if (productIds.length === 0) return [];

  // PAGINATION-EXEMPT: bounded by COMPARE_HARD_CAP (max 4).
  const rows = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: {
      id: true, slug: true, sku: true, name: true, shortDesc: true,
      mrpPaise: true, pricePaise: true, b2bPricePaise: true,
      gstRate: true, hsnCode: true, stock: true, lowStockAt: true,
      attributes: true,
      brand:    { select: { name: true, slug: true } },
      category: { select: { name: true, slug: true } },
      // Item 19 — only show active images in the compare grid.
      images:   { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], select: { url: true } },
      variants: {
        where: { isActive: true },
        select: { id: true, name: true, attributes: true, pricePaise: true, stock: true },
      },
    },
  });

  // Aggregate reviews per product in one extra query (Prisma can't
  // express conditional `count by rating` inside the select above).
  const reviewAgg = await prisma.review.groupBy({
    by: ['productId', 'rating'],
    where: { productId: { in: rows.map((r) => r.id) }, isApproved: true },
    _count: { _all: true },
  });

  const reviewsByProduct = new Map<string, { sum: number; total: number; buckets: Record<number, number> }>();
  for (const agg of reviewAgg) {
    const existing = reviewsByProduct.get(agg.productId) ?? { sum: 0, total: 0, buckets: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    const count = agg._count._all;
    existing.sum   += agg.rating * count;
    existing.total += count;
    existing.buckets[agg.rating] = (existing.buckets[agg.rating] ?? 0) + count;
    reviewsByProduct.set(agg.productId, existing);
  }

  // Order results to match the input array (Prisma `IN` returns
  // arbitrary order).
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: CompareProduct[] = [];
  for (const id of productIds) {
    const r = byId.get(id);
    if (!r) continue;

    const stockStatus: CompareProduct['display']['stockStatus'] =
      r.stock <= 0                     ? 'OUT_OF_STOCK'
    : r.stock <= (r.lowStockAt ?? 5)   ? 'LOW_STOCK'
    :                                    'IN_STOCK';

    const agg = reviewsByProduct.get(r.id) ?? { sum: 0, total: 0, buckets: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    const avg = agg.total === 0 ? 0 : agg.sum / agg.total;
    const distribution = {
      1: agg.total === 0 ? 0 : Math.round((agg.buckets[1] / agg.total) * 100),
      2: agg.total === 0 ? 0 : Math.round((agg.buckets[2] / agg.total) * 100),
      3: agg.total === 0 ? 0 : Math.round((agg.buckets[3] / agg.total) * 100),
      4: agg.total === 0 ? 0 : Math.round((agg.buckets[4] / agg.total) * 100),
      5: agg.total === 0 ? 0 : Math.round((agg.buckets[5] / agg.total) * 100),
    } as const;

    ordered.push({
      id:            r.id,
      slug:          r.slug,
      sku:           r.sku,
      name:          r.name,
      shortDesc:     r.shortDesc,
      brand:         r.brand,
      category:      r.category,
      imageUrl:      r.images[0]?.url ?? null,
      mrpPaise:      r.mrpPaise,
      pricePaise:    r.pricePaise,
      b2bPricePaise: r.b2bPricePaise,
      gstRate:       r.gstRate,
      hsnCode:       r.hsnCode,
      stock:         r.stock,
      lowStockAt:    r.lowStockAt,
      attributes:    parseAttributes(r.attributes),
      display: {
        mrp:             rupees(r.mrpPaise),
        price:           rupees(r.pricePaise),
        discountPercent: discountPercent(r.mrpPaise, r.pricePaise),
        stockStatus,
      },
      variants: r.variants.map((v) => ({
        id:         v.id,
        name:       v.name,
        attributes: parseAttributes(v.attributes),
        pricePaise: v.pricePaise,
        stock:      v.stock,
      })),
      reviews: {
        averageRating: Number(avg.toFixed(2)),
        count:         agg.total,
        distribution,
      },
    });
  }
  return ordered;
}

/** Resolve product slugs (share-URL path) to IDs, preserving input
 *  order. Unknown / inactive slugs are dropped silently. */
export async function resolveSlugsToIds(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];
  // PAGINATION-EXEMPT: bounded by share-URL max (4).
  const rows = await prisma.product.findMany({
    where:  { slug: { in: slugs }, isActive: true },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
  return slugs.map((s) => bySlug.get(s)).filter((id): id is string => typeof id === 'string');
}
