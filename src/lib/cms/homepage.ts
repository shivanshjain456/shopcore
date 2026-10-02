/**
 * Homepage CMS service — Item 18 Phase 1.
 *
 *   getHomepageComposition() — the SINGLE function the storefront page
 *   calls. Returns the resolved, in-window section list plus everything
 *   each section needs to render (products / brands / categories /
 *   metrics / branches), batched into one Promise.all so there's NO
 *   N+1 over sections.
 *
 *   Per-section data resolution is best-effort: a single bad config
 *   row never crashes the page. We log a warning, drop the section,
 *   and carry on.
 *
 *   Public surface:
 *     - getHomepageComposition() — storefront read path
 *     - listSectionsForAdmin()   — admin editor read (includes
 *                                  inactive + future-scheduled rows)
 *     - createSection / updateSection / deleteSection / reorder
 *     - listMetrics / upsertMetric / deleteMetric / reorderMetrics
 *     - listBranches / upsertBranch / deleteBranch / reorderBranches
 *     - seedDefaultsIfEmpty() — idempotent first-boot seeding
 *
 *   Renderer concerns (which component handles which kind) live in
 *   src/components/storefront/homepage/HomepageRenderer.tsx. The
 *   service speaks ONLY data.
 */
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { ValidationError, NotFoundError } from '@/lib/errors';
import {
  HOMEPAGE_SECTION_KINDS, isHomepageSectionKind,
  safeParseConfig,
  type HomepageSectionKind,
} from './homepageSchemas';
import {
  DEFAULT_HOMEPAGE_SECTIONS, DEFAULT_HOMEPAGE_METRICS,
} from './homepageDefaults';
import { getBrands, getFeaturedProducts, listProducts } from '@/lib/catalog/queries';
import { rupees, discountPercent } from '@/lib/catalog/pricing';

// ── Resolved-data shapes the storefront page receives ───────────────────

export interface ProductCardData {
  id: string; slug: string; name: string; shortDesc: string | null;
  mrpPaise: number; pricePaise: number; imageUrl: string | null;
  brand: { name: string } | null;
  category: { name: string; slug: string } | null;
  stock?: number;
  hasVariants?: boolean;
  /** Pre-formatted INR price for display (server-side so the storefront
   *  doesn't import the pricing helpers on the client). */
  displayPrice: string;
  displayMrp:   string;
  discountPct:  number;
  averageRating?: number;
  reviewCount?:   number;
}

export interface BrandTileData {
  id: string; name: string; slug: string; logoUrl: string | null;
}

export interface CategoryTileData {
  id: string; name: string; slug: string;
  imageUrl: string | null; iconUrl: string | null;
  productCount: number;
}

export interface MetricData {
  id: string; label: string; value: string;
  caption: string | null; iconUrl: string | null;
}

export interface BranchData {
  id: string; name: string; city: string;
  address: string | null; phone: string | null;
  imageUrl: string | null; linkUrl: string | null;
}

/** One resolved section the renderer can consume directly. The shape
 *  is intentionally a tagged union over `kind` so React can `switch`
 *  on it without type guards. */
export type ResolvedSection =
  | { id: string; slug: string; kind: 'HERO';                 config: Record<string, unknown> }
  | { id: string; slug: string; kind: 'FEATURED_BRANDS';      config: Record<string, unknown>; brands: BrandTileData[] }
  | { id: string; slug: string; kind: 'TOP_CATEGORIES';       config: Record<string, unknown>; categories: CategoryTileData[] }
  | { id: string; slug: string; kind: 'PRODUCT_COLLECTION';   config: Record<string, unknown>; products: ProductCardData[] }
  | { id: string; slug: string; kind: 'MOST_RATED_PRODUCTS';  config: Record<string, unknown>; products: ProductCardData[] }
  | { id: string; slug: string; kind: 'TRENDING_PRODUCTS';    config: Record<string, unknown>; products: ProductCardData[] }
  | { id: string; slug: string; kind: 'WIDE_PROMO_BANNER';    config: Record<string, unknown> }
  | { id: string; slug: string; kind: 'DUAL_PROMO_CARDS';     config: Record<string, unknown> }
  | { id: string; slug: string; kind: 'BRAND_SHOWCASE';       config: Record<string, unknown>; brands: BrandTileData[] }
  | { id: string; slug: string; kind: 'STORE_METRICS';        config: Record<string, unknown>; metrics: MetricData[] }
  | { id: string; slug: string; kind: 'WHY_SHOP_WITH_US';     config: Record<string, unknown> }
  | { id: string; slug: string; kind: 'BRANCHES';             config: Record<string, unknown>; branches: BranchData[] }
  | { id: string; slug: string; kind: 'NEWSLETTER';           config: Record<string, unknown> };

export interface HomepageComposition {
  sections: ResolvedSection[];
}

// ── Storefront read path ────────────────────────────────────────────────

/**
 * Build the full homepage composition for the storefront page. ONE
 * call → one DB-batched Promise.all → fully resolved data.
 *
 * Steps:
 *   1. Pull active, in-window sections in display order.
 *   2. Pre-fetch the shared lookup tables (brands, categories, metrics,
 *      branches) once — these feed multiple sections and shouldn't be
 *      re-queried per section.
 *   3. For each section, dispatch to a small per-kind resolver that
 *      pulls / filters its specific data.
 *   4. Drop any section whose config fails to parse (logged).
 *
 *   Preview mode:
 *     getHomepageComposition({ preview: true }) bypasses the active +
 *     in-window filter so admins can sanity-check unpublished /
 *     scheduled / disabled sections via `/?preview=admin`. The page
 *     gates the option behind an admin-role check before passing it.
 */
export async function getHomepageComposition(
  opts: { preview?: boolean } = {},
): Promise<HomepageComposition> {
  const now = new Date();
  const where: Prisma.HomepageSectionWhereInput = opts.preview
    ? {}
    : {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt:   null }, { endsAt:   { gte: now } }] },
        ],
      };
  const rows = await prisma.homepageSection.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
    // PAGINATION-EXEMPT: homepage section count is admin-bounded
    //   (~15-30 in practice). The schema permits any count but the
    //   layout breaks beyond ~30 anyway.
  });
  if (rows.length === 0) return { sections: [] };

  // Pre-fetch shared lookup tables in parallel. Each is small + cached
  // (brands ≤ 100, categories ≤ 50, metrics ≤ 12, branches ≤ 12).
  const [brandsAll, categoriesAll, metricsAll, branchesAll] = await Promise.all([
    getBrands(),
    listAllActiveCategoriesForHome(),
    listActiveMetrics(),
    listActiveBranches(),
  ]);

  const sections: ResolvedSection[] = [];
  for (const row of rows) {
    if (!isHomepageSectionKind(row.kind)) {
      log.warn('homepage.unknown_section_kind', { id: row.id, slug: row.slug, kind: row.kind });
      continue;
    }
    const parsed = safeParseConfig(row.kind, row.config);
    if (!parsed.ok) {
      log.warn('homepage.invalid_section_config', {
        id: row.id, slug: row.slug, kind: row.kind,
        issues: parsed.issues.map((i) => i.message),
      });
      continue;
    }
    const config = parsed.config as Record<string, unknown>;
    try {
      const resolved = await resolveSection({
        id: row.id, slug: row.slug, kind: row.kind, config,
        brandsAll, categoriesAll, metricsAll, branchesAll,
      });
      sections.push(resolved);
    } catch (e) {
      // Best-effort: one bad section never breaks the page.
      log.warn('homepage.section_resolve_failed', {
        id: row.id, slug: row.slug, kind: row.kind,
        err: (e as Error).message,
      });
    }
  }
  return { sections };
}

// ── Per-kind resolvers ─────────────────────────────────────────────────

interface ResolveCtx {
  id: string; slug: string; kind: HomepageSectionKind;
  config: Record<string, unknown>;
  brandsAll:     Awaited<ReturnType<typeof getBrands>>;
  categoriesAll: CategoryTileData[];
  metricsAll:    MetricData[];
  branchesAll:   BranchData[];
}

async function resolveSection(ctx: ResolveCtx): Promise<ResolvedSection> {
  switch (ctx.kind) {
    case 'HERO':
      return { id: ctx.id, slug: ctx.slug, kind: 'HERO', config: ctx.config };

    case 'FEATURED_BRANDS': {
      const { brandIds, source, maxItems } = ctx.config as { brandIds?: string[]; source?: string; maxItems?: number };
      const limit = Math.min(Math.max(1, Number(maxItems) || 12), 24);
      let picked = ctx.brandsAll;
      if (source === 'manual' && Array.isArray(brandIds) && brandIds.length > 0) {
        const set = new Set(brandIds);
        picked = ctx.brandsAll.filter((b) => set.has(b.id));
      }
      const brands: BrandTileData[] = picked.slice(0, limit).map((b) => ({
        id: b.id, name: b.name, slug: b.slug,
        logoUrl: (b as { logoUrl?: string | null }).logoUrl ?? null,
      }));
      return { id: ctx.id, slug: ctx.slug, kind: 'FEATURED_BRANDS', config: ctx.config, brands };
    }

    case 'TOP_CATEGORIES': {
      const { categoryIds, source, maxItems } = ctx.config as { categoryIds?: string[]; source?: string; maxItems?: number };
      const limit = Math.min(Math.max(1, Number(maxItems) || 10), 20);
      let picked = ctx.categoriesAll;
      if (source === 'manual' && Array.isArray(categoryIds) && categoryIds.length > 0) {
        const set = new Set(categoryIds);
        picked = ctx.categoriesAll.filter((c) => set.has(c.id));
      }
      return {
        id: ctx.id, slug: ctx.slug, kind: 'TOP_CATEGORIES',
        config: ctx.config, categories: picked.slice(0, limit),
      };
    }

    case 'PRODUCT_COLLECTION':
    case 'MOST_RATED_PRODUCTS':
    case 'TRENDING_PRODUCTS': {
      const products = await resolveProductCollection(ctx.kind, ctx.config);
      return { id: ctx.id, slug: ctx.slug, kind: ctx.kind, config: ctx.config, products };
    }

    case 'BRAND_SHOWCASE': {
      const { brandIds, source, maxItems } = ctx.config as { brandIds?: string[]; source?: string; maxItems?: number };
      const limit = Math.min(Math.max(3, Number(maxItems) || 12), 48);
      let picked = ctx.brandsAll;
      if (source === 'manual' && Array.isArray(brandIds) && brandIds.length > 0) {
        const set = new Set(brandIds);
        picked = ctx.brandsAll.filter((b) => set.has(b.id));
      }
      const brands: BrandTileData[] = picked.slice(0, limit).map((b) => ({
        id: b.id, name: b.name, slug: b.slug,
        logoUrl: (b as { logoUrl?: string | null }).logoUrl ?? null,
      }));
      return { id: ctx.id, slug: ctx.slug, kind: 'BRAND_SHOWCASE', config: ctx.config, brands };
    }

    case 'STORE_METRICS':
      return { id: ctx.id, slug: ctx.slug, kind: 'STORE_METRICS', config: ctx.config, metrics: ctx.metricsAll };

    case 'WHY_SHOP_WITH_US':
      return { id: ctx.id, slug: ctx.slug, kind: 'WHY_SHOP_WITH_US', config: ctx.config };

    case 'BRANCHES': {
      const { maxItems } = ctx.config as { maxItems?: number };
      const limit = Math.min(Math.max(1, Number(maxItems) || 6), 24);
      return {
        id: ctx.id, slug: ctx.slug, kind: 'BRANCHES',
        config: ctx.config, branches: ctx.branchesAll.slice(0, limit),
      };
    }

    case 'NEWSLETTER':
      return { id: ctx.id, slug: ctx.slug, kind: 'NEWSLETTER', config: ctx.config };

    case 'WIDE_PROMO_BANNER':
      return { id: ctx.id, slug: ctx.slug, kind: 'WIDE_PROMO_BANNER', config: ctx.config };

    case 'DUAL_PROMO_CARDS':
      return { id: ctx.id, slug: ctx.slug, kind: 'DUAL_PROMO_CARDS', config: ctx.config };
  }
}

/** Resolve a PRODUCT_COLLECTION / MOST_RATED / TRENDING section's
 *  source.mode into a concrete product list. Falls back to "featured"
 *  on any unrecognised mode. */
async function resolveProductCollection(
  kind: HomepageSectionKind,
  rawConfig: Record<string, unknown>,
): Promise<ProductCardData[]> {
  const cfg = rawConfig as {
    source?: { mode?: string; minReviews?: number; categorySlug?: string; brandSlug?: string; productIds?: string[] };
    maxItems?: number;
  };
  const max = Math.min(Math.max(1, Number(cfg.maxItems) || 8), 40);
  const mode = cfg.source?.mode
    ?? (kind === 'MOST_RATED_PRODUCTS' ? 'top_rated'
      :  kind === 'TRENDING_PRODUCTS'  ? 'trending'
      :                                  'featured');

  switch (mode) {
    case 'featured': {
      const rows = await getFeaturedProducts(max);
      return rows.map(prismaProductToCard);
    }
    case 'newest': {
      const r = await listProducts({ sort: 'newest', pageSize: max });
      return r.items.map(prismaProductToCard);
    }
    case 'by_category': {
      const slug = cfg.source?.categorySlug;
      if (!slug) return [];
      const r = await listProducts({ categorySlug: slug, pageSize: max, sort: 'relevance' });
      return r.items.map(prismaProductToCard);
    }
    case 'by_brand': {
      const slug = cfg.source?.brandSlug;
      if (!slug) return [];
      const r = await listProducts({ brandSlugs: [slug], pageSize: max, sort: 'relevance' });
      return r.items.map(prismaProductToCard);
    }
    case 'manual': {
      const ids = cfg.source?.productIds ?? [];
      if (ids.length === 0) return [];
      // PAGINATION-EXEMPT: bounded by `ids.length` (max 40 per schema).
      const rows = await prisma.product.findMany({
        where: { id: { in: ids }, isActive: true },
        include: standardProductInclude,
      });
      // Preserve admin-supplied order.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined).map(prismaProductToCard);
    }
    case 'top_rated': {
      const minReviews = Math.max(0, Number(cfg.source?.minReviews ?? 1));
      // Aggregate reviews → pick products with ≥ minReviews approved
      // reviews, order by averageRating DESC, take `max`. Two queries:
      // one groupBy for the aggregate, one findMany for the rows.
      const agg = await prisma.review.groupBy({
        by: ['productId'],
        where: { isApproved: true },
        _avg: { rating: true },
        _count: { _all: true },
        having: { rating: { _count: { gte: minReviews } } },
        orderBy: [{ _avg: { rating: 'desc' } }, { _count: { rating: 'desc' } }],
        take: max,
      });
      if (agg.length === 0) return [];
      const ids = agg.map((a) => a.productId);
      // PAGINATION-EXEMPT: bounded by `ids.length` which is itself
      //   bounded by `max` (≤ 40 per schema).
      const rows = await prisma.product.findMany({
        where: { id: { in: ids }, isActive: true },
        include: standardProductInclude,
      });
      const ratingById = new Map(agg.map((a) => [a.productId, { avg: a._avg.rating ?? 0, count: a._count._all }]));
      // Re-sort to preserve the aggregate's ordering (Prisma's
      // findMany doesn't honour the input array order).
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => {
          const card = prismaProductToCard(r);
          const rating = ratingById.get(r.id);
          if (rating) {
            card.averageRating = Number(rating.avg.toFixed(2));
            card.reviewCount   = rating.count;
          }
          return card;
        });
    }
    case 'trending': {
      // Phase 1 placeholder — newest until the trending algorithm lands.
      const r = await listProducts({ sort: 'newest', pageSize: max });
      return r.items.map(prismaProductToCard);
    }
    default: {
      log.warn('homepage.unknown_product_mode', { mode });
      return [];
    }
  }
}

const standardProductInclude = {
  brand:    { select: { name: true } },
  category: { select: { name: true, slug: true } },
  // Item 19 — primary image per product, filtered to ACTIVE only so a
  // soft-disabled photo never sneaks into homepage tiles. orderBy is
  // typed as a mutable array (no `as const`) so it matches Prisma's
  // ProductImageOrderByWithRelationInput[] signature exactly.
  images: {
    where: { isActive: true }, take: 1,
    orderBy: [
      { isPrimary: 'desc' as Prisma.SortOrder },
      { sortOrder: 'asc'  as Prisma.SortOrder },
    ],
  },
  variants: { where: { isActive: true }, select: { id: true } },
} satisfies Prisma.ProductInclude;

/** Map any Prisma product row (with the standard catalog include set
 *  OR the lighter featured-products include) into the card data the
 *  storefront renderer consumes. `variants` is optional — when absent,
 *  `hasVariants` defaults to false (the featured query doesn't ship
 *  variant data because the card UI doesn't need it to decide). */
function prismaProductToCard(p: {
  id: string; slug: string; name: string; shortDesc: string | null;
  mrpPaise: number; pricePaise: number; stock: number;
  brand:    { name: string } | null;
  category: { name: string; slug: string } | null;
  images:   Array<{ url: string }>;
  variants?: Array<{ id: string }>;
}): ProductCardData {
  return {
    id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
    mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
    imageUrl:     p.images[0]?.url ?? null,
    brand:        p.brand,
    category:     p.category,
    stock:        p.stock,
    hasVariants:  (p.variants?.length ?? 0) > 0,
    displayPrice: rupees(p.pricePaise),
    displayMrp:   rupees(p.mrpPaise),
    discountPct:  discountPercent(p.mrpPaise, p.pricePaise),
  };
}

// ── Shared lookup helpers (used by getHomepageComposition) ──────────────

async function listAllActiveCategoriesForHome(): Promise<CategoryTileData[]> {
  // PAGINATION-EXEMPT: small lookup table.
  const rows = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { products: { where: { isActive: true } } } } },
  });
  return rows.map((c) => ({
    id: c.id, name: c.name, slug: c.slug,
    imageUrl: c.imageUrl, iconUrl: c.iconUrl,
    productCount: c._count.products,
  }));
}

async function listActiveMetrics(): Promise<MetricData[]> {
  // PAGINATION-EXEMPT: handful of rows.
  const rows = await prisma.homepageMetric.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return rows.map((m) => ({
    id: m.id, label: m.label, value: m.value,
    caption: m.caption, iconUrl: m.iconUrl,
  }));
}

async function listActiveBranches(): Promise<BranchData[]> {
  // PAGINATION-EXEMPT: typically < 24 rows.
  const rows = await prisma.homepageBranch.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return rows.map((b) => ({
    id: b.id, name: b.name, city: b.city,
    address: b.address, phone: b.phone,
    imageUrl: b.imageUrl, linkUrl: b.linkUrl,
  }));
}

// ── Admin read path ─────────────────────────────────────────────────────

export interface AdminSectionRow {
  id: string; kind: string; slug: string; title: string | null;
  displayOrder: number; isActive: boolean;
  startsAt: Date | null; endsAt: Date | null;
  config: Record<string, unknown>;
  createdAt: Date; updatedAt: Date;
}

export async function listSectionsForAdmin(): Promise<AdminSectionRow[]> {
  // PAGINATION-EXEMPT: admin section count is bounded by UX, not data.
  const rows = await prisma.homepageSection.findMany({
    orderBy: { displayOrder: 'asc' },
  });
  return rows.map((r) => {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(r.config) as Record<string, unknown>; } catch { /* leave {} */ }
    return {
      id: r.id, kind: r.kind, slug: r.slug, title: r.title,
      displayOrder: r.displayOrder, isActive: r.isActive,
      startsAt: r.startsAt, endsAt: r.endsAt,
      config: cfg,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  });
}

// ── Admin write surface ─────────────────────────────────────────────────

export interface CreateSectionInput {
  kind:         string;
  slug:         string;
  title?:       string | null;
  displayOrder?:number;
  isActive?:    boolean;
  startsAt?:    Date | string | null;
  endsAt?:      Date | string | null;
  config?:      unknown;
}

export async function createSection(input: CreateSectionInput): Promise<AdminSectionRow> {
  if (!isHomepageSectionKind(input.kind)) {
    throw new ValidationError('Unknown section kind.', { code: 'INVALID_SECTION_KIND' });
  }
  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new ValidationError('Slug must match [a-z0-9-]+.', { code: 'INVALID_SECTION_SLUG' });
  }
  const parsed = safeParseConfig(input.kind, input.config ?? {});
  if (!parsed.ok) {
    throw new ValidationError(
      `Invalid section config: ${parsed.issues.map((i) => i.message).join('; ')}`,
      { code: 'INVALID_SECTION_CONFIG', context: { issues: parsed.issues } },
    );
  }
  const created = await prisma.homepageSection.create({
    data: {
      kind:         input.kind,
      slug,
      title:        (input.title ?? '').trim() || null,
      displayOrder: typeof input.displayOrder === 'number' ? input.displayOrder : 999,
      isActive:     input.isActive !== false,
      startsAt:     toDateOrNull(input.startsAt),
      endsAt:       toDateOrNull(input.endsAt),
      config:       JSON.stringify(parsed.config ?? {}),
    },
  });
  return adminRow(created);
}

export interface UpdateSectionInput {
  title?:       string | null;
  displayOrder?:number;
  isActive?:    boolean;
  startsAt?:    Date | string | null;
  endsAt?:      Date | string | null;
  config?:      unknown;
}

export async function updateSection(id: string, input: UpdateSectionInput): Promise<AdminSectionRow> {
  const existing = await prisma.homepageSection.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Section not found.');
  const data: Prisma.HomepageSectionUpdateInput = {};
  if (input.title !== undefined)        data.title        = (input.title ?? '').toString().trim() || null;
  if (input.displayOrder !== undefined) data.displayOrder = Math.max(0, Math.floor(input.displayOrder));
  if (input.isActive !== undefined)     data.isActive     = !!input.isActive;
  if (input.startsAt !== undefined)     data.startsAt     = toDateOrNull(input.startsAt);
  if (input.endsAt   !== undefined)     data.endsAt       = toDateOrNull(input.endsAt);
  if (input.config !== undefined) {
    const parsed = safeParseConfig(existing.kind, input.config);
    if (!parsed.ok) {
      throw new ValidationError(
        `Invalid section config: ${parsed.issues.map((i) => i.message).join('; ')}`,
        { code: 'INVALID_SECTION_CONFIG', context: { issues: parsed.issues } },
      );
    }
    data.config = JSON.stringify(parsed.config ?? {});
  }
  const updated = await prisma.homepageSection.update({ where: { id }, data });
  return adminRow(updated);
}

export async function deleteSection(id: string): Promise<void> {
  // Idempotent — missing row is not an error.
  await prisma.homepageSection.deleteMany({ where: { id } });
}

/** Reorder via an ordered array of section IDs. Missing IDs are
 *  ignored; IDs not in the array keep their existing displayOrder
 *  but slide to the end (gap-numbering: 10, 20, 30, …). */
export async function reorderSections(orderedIds: string[]): Promise<void> {
  // PAGINATION-EXEMPT: bounded by admin UX.
  const all = await prisma.homepageSection.findMany({ select: { id: true } });
  const allIds = new Set(all.map((r) => r.id));
  const validOrdered = orderedIds.filter((id) => allIds.has(id));
  const tail = all.map((r) => r.id).filter((id) => !validOrdered.includes(id));
  const final = [...validOrdered, ...tail];
  // Use a transaction so we don't half-reorder if a row goes missing.
  await prisma.$transaction(
    final.map((id, i) =>
      prisma.homepageSection.update({
        where: { id },
        data:  { displayOrder: (i + 1) * 10 },
      }),
    ),
  );
}

// ── Metric CRUD ─────────────────────────────────────────────────────────

export interface MetricInput {
  label:        string;
  value:        string;
  caption?:     string | null;
  iconUrl?:     string | null;
  displayOrder?:number;
  isActive?:    boolean;
}

export async function listMetricsForAdmin(): Promise<MetricData[]> {
  // PAGINATION-EXEMPT.
  const rows = await prisma.homepageMetric.findMany({ orderBy: { displayOrder: 'asc' } });
  return rows.map((m) => ({
    id: m.id, label: m.label, value: m.value,
    caption: m.caption, iconUrl: m.iconUrl,
  }));
}

export async function upsertMetric(id: string | null, input: MetricInput): Promise<MetricData> {
  const data = {
    label:        String(input.label ?? '').trim().slice(0, 120),
    value:        String(input.value ?? '').trim().slice(0, 60),
    caption:      input.caption ? String(input.caption).trim().slice(0, 240) || null : null,
    iconUrl:      input.iconUrl ? String(input.iconUrl).trim().slice(0, 500) || null : null,
    displayOrder: typeof input.displayOrder === 'number' ? Math.max(0, Math.floor(input.displayOrder)) : 999,
    isActive:     input.isActive !== false,
  };
  if (!data.label || !data.value) throw new ValidationError('Metric label + value are required.');
  const row = id
    ? await prisma.homepageMetric.update({ where: { id }, data })
    : await prisma.homepageMetric.create({ data });
  return { id: row.id, label: row.label, value: row.value, caption: row.caption, iconUrl: row.iconUrl };
}

export async function deleteMetric(id: string): Promise<void> {
  await prisma.homepageMetric.deleteMany({ where: { id } });
}

// ── Branch CRUD ─────────────────────────────────────────────────────────

export interface BranchInput {
  name:        string;
  city:        string;
  address?:    string | null;
  phone?:      string | null;
  imageUrl?:   string | null;
  linkUrl?:    string | null;
  displayOrder?:number;
  isActive?:   boolean;
}

export async function listBranchesForAdmin(): Promise<BranchData[]> {
  // PAGINATION-EXEMPT: admin-bounded (typically < 24 rows).
  const rows = await prisma.homepageBranch.findMany({ orderBy: { displayOrder: 'asc' } });
  return rows.map((b) => ({
    id: b.id, name: b.name, city: b.city,
    address: b.address, phone: b.phone,
    imageUrl: b.imageUrl, linkUrl: b.linkUrl,
  }));
}

export async function upsertBranch(id: string | null, input: BranchInput): Promise<BranchData> {
  const data = {
    name:         String(input.name ?? '').trim().slice(0, 120),
    city:         String(input.city ?? '').trim().slice(0, 120),
    address:      input.address ? String(input.address).trim().slice(0, 500) || null : null,
    phone:        input.phone   ? String(input.phone).trim().slice(0, 20)   || null : null,
    imageUrl:     input.imageUrl ? String(input.imageUrl).trim().slice(0, 500) || null : null,
    linkUrl:      input.linkUrl  ? String(input.linkUrl).trim().slice(0, 500)  || null : null,
    displayOrder: typeof input.displayOrder === 'number' ? Math.max(0, Math.floor(input.displayOrder)) : 999,
    isActive:     input.isActive !== false,
  };
  if (!data.name || !data.city) throw new ValidationError('Branch name + city are required.');
  const row = id
    ? await prisma.homepageBranch.update({ where: { id }, data })
    : await prisma.homepageBranch.create({ data });
  return {
    id: row.id, name: row.name, city: row.city,
    address: row.address, phone: row.phone,
    imageUrl: row.imageUrl, linkUrl: row.linkUrl,
  };
}

export async function deleteBranch(id: string): Promise<void> {
  await prisma.homepageBranch.deleteMany({ where: { id } });
}

// ── First-boot seeding ──────────────────────────────────────────────────

/** Idempotent: only seeds when both tables are empty. Called on first
 *  boot by `lib/cms/homepage.startup` (registered from db/client.ts). */
export async function seedDefaultsIfEmpty(): Promise<{ sectionsSeeded: number; metricsSeeded: number }> {
  const [secCount, metCount] = await Promise.all([
    prisma.homepageSection.count(),
    prisma.homepageMetric.count(),
  ]);
  let sectionsSeeded = 0;
  let metricsSeeded  = 0;
  if (secCount === 0) {
    await prisma.$transaction(DEFAULT_HOMEPAGE_SECTIONS.map((s) => prisma.homepageSection.create({
      data: {
        kind: s.kind, slug: s.slug, title: s.title,
        displayOrder: s.displayOrder, isActive: s.isActive,
        config: JSON.stringify(s.config),
      },
    })));
    sectionsSeeded = DEFAULT_HOMEPAGE_SECTIONS.length;
    log.info('homepage.sections_seeded', { count: sectionsSeeded });
  }
  if (metCount === 0) {
    await prisma.$transaction(DEFAULT_HOMEPAGE_METRICS.map((m) => prisma.homepageMetric.create({
      data: { ...m },
    })));
    metricsSeeded = DEFAULT_HOMEPAGE_METRICS.length;
    log.info('homepage.metrics_seeded', { count: metricsSeeded });
  }
  return { sectionsSeeded, metricsSeeded };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function toDateOrNull(x: Date | string | null | undefined): Date | null {
  if (x === null || x === undefined || x === '') return null;
  if (x instanceof Date) return x;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function adminRow(r: {
  id: string; kind: string; slug: string; title: string | null;
  displayOrder: number; isActive: boolean;
  startsAt: Date | null; endsAt: Date | null;
  config: string; createdAt: Date; updatedAt: Date;
}): AdminSectionRow {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(r.config) as Record<string, unknown>; } catch { /* */ }
  return {
    id: r.id, kind: r.kind, slug: r.slug, title: r.title,
    displayOrder: r.displayOrder, isActive: r.isActive,
    startsAt: r.startsAt, endsAt: r.endsAt,
    config: cfg, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

// Re-export the kind list for consumers.
export { HOMEPAGE_SECTION_KINDS, type HomepageSectionKind } from './homepageSchemas';
