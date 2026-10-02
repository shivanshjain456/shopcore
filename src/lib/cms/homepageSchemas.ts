/**
 * Homepage CMS — section kinds + per-kind config schemas.
 * Item 18 Phase 1.
 *
 *   `HOMEPAGE_SECTION_KINDS` is the canonical list of renderers the
 *   storefront knows how to draw. Adding a new kind means: (1) add it
 *   here, (2) add a Zod schema for its config, (3) implement the
 *   render branch in <HomepageRenderer>.
 *
 *   Per-kind configs are intentionally narrow:
 *     - one schema per kind (no shared base — narrowing stays clean
 *       at the call site),
 *     - JSON-string ↔ object parsing happens in the service layer
 *       (`parseSectionConfig`) so the route handlers never see raw
 *       JSON,
 *     - `safeParseConfig(kind, raw)` returns `{ ok: true, config }`
 *       OR `{ ok: false, issues }` — never throws. UI surfaces use
 *       `issues` for inline validation; the public homepage service
 *       falls back to a sensible default and logs a warning so a
 *       single bad row never takes down the whole page.
 *
 * Pure module — no Prisma, no Next imports.
 */
import { z } from 'zod';
import { ValidationError } from '@/lib/errors';

// ── Section kinds ────────────────────────────────────────────────────────

export const HOMEPAGE_SECTION_KINDS = [
  'HERO',                  // existing HeroCarousel; config picks which banner set
  'FEATURED_BRANDS',       // horizontal brand logo strip
  'TOP_CATEGORIES',        // category tile grid
  'PRODUCT_COLLECTION',    // generic — featured / newest / by category / by brand / by IDs / by rating
  'WIDE_PROMO_BANNER',     // full-width image with CTA
  'DUAL_PROMO_CARDS',      // two side-by-side promo tiles
  'BRAND_SHOWCASE',        // hero-brand + scrolling logos band
  'STORE_METRICS',         // "170+ brands · 10M+ customers · 1000+ orders" tiles
  'WHY_SHOP_WITH_US',      // 3-5 trust cards (genuine products, GST billing, …)
  'BRANCHES',              // physical store locations
  'NEWSLETTER',            // CTA block — email capture (future hook)
  'MOST_RATED_PRODUCTS',   // shortcut over PRODUCT_COLLECTION with sort = avg_rating
  'TRENDING_PRODUCTS',     // shortcut over PRODUCT_COLLECTION (algorithm TBD)
] as const;

export type HomepageSectionKind = typeof HOMEPAGE_SECTION_KINDS[number];

export function isHomepageSectionKind(s: unknown): s is HomepageSectionKind {
  return typeof s === 'string' && (HOMEPAGE_SECTION_KINDS as readonly string[]).includes(s);
}

// ── Shared sub-schemas ───────────────────────────────────────────────────

/** Optional CTA pair — every section that can have a call-to-action
 *  uses this shape. Both fields blank → no CTA rendered. */
const ctaSchema = z.object({
  label: z.string().trim().max(60).default(''),
  href:  z.string().trim().max(500).default(''),
}).partial().default({});

/** "Soft" background theme — a Tailwind class fragment. The renderer
 *  maps these to concrete bg classes so we can extend the palette
 *  without invalidating stored configs. */
const themeSchema = z.enum(['default', 'sky', 'amber', 'emerald', 'rose', 'slate']).default('default');

// ── Per-kind config schemas ──────────────────────────────────────────────

/** HERO — config is empty for Phase 1 (the section renders whatever
 *  the existing HeroCarousel + admin hero-banners returns). Future
 *  knobs can be added without migrations. */
const heroConfigSchema = z.object({}).default({});

/** FEATURED_BRANDS — pick brands manually OR auto-pick top N. */
const featuredBrandsConfigSchema = z.object({
  source:    z.enum(['auto', 'manual']).default('auto'),
  brandIds:  z.array(z.string().trim().min(1).max(64)).default([]),
  maxItems:  z.number().int().min(1).max(24).default(12),
  heading:   z.string().trim().max(120).default('Shop by brand'),
  subheading:z.string().trim().max(240).default(''),
}).default({});

/** TOP_CATEGORIES — pick categories manually OR auto by sortOrder. */
const topCategoriesConfigSchema = z.object({
  source:     z.enum(['auto', 'manual']).default('auto'),
  categoryIds:z.array(z.string().trim().min(1).max(64)).default([]),
  maxItems:   z.number().int().min(1).max(20).default(10),
  heading:    z.string().trim().max(120).default('Shop by category'),
  subheading: z.string().trim().max(240).default(''),
  layout:     z.enum(['tiles', 'compact']).default('tiles'),
}).default({});

/** PRODUCT_COLLECTION — the workhorse. Mode picks where the products
 *  come from; the relevant `<mode>Config` field is read by the
 *  service. Manual mode trumps everything else. */
const productCollectionConfigSchema = z.object({
  heading:    z.string().trim().max(120).default('Featured products'),
  subheading: z.string().trim().max(240).default(''),
  theme:      themeSchema,
  cta:        ctaSchema,
  source: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('featured') }),
    z.object({ mode: z.literal('newest')   }),
    z.object({ mode: z.literal('top_rated'), minReviews: z.number().int().min(0).max(10_000).default(1) }),
    z.object({ mode: z.literal('trending') }),  // for now == newest; algorithm TBD
    z.object({ mode: z.literal('by_category'), categorySlug: z.string().trim().min(1).max(64) }),
    z.object({ mode: z.literal('by_brand'),    brandSlug:    z.string().trim().min(1).max(64) }),
    z.object({ mode: z.literal('manual'),      productIds:   z.array(z.string().trim().min(1).max(64)).max(40).default([]) }),
  ]).default({ mode: 'featured' } as { mode: 'featured' }),
  maxItems: z.number().int().min(1).max(40).default(8),
}).default({});

/** WIDE_PROMO_BANNER — large hero-style banner between sections. */
const widePromoBannerConfigSchema = z.object({
  imageDesktopUrl: z.string().trim().max(500).default(''),
  imageMobileUrl:  z.string().trim().max(500).default(''),
  imageAlt:        z.string().trim().max(200).default(''),
  headline:        z.string().trim().max(120).default(''),
  subheadline:     z.string().trim().max(240).default(''),
  cta:             ctaSchema,
  theme:           themeSchema,
}).default({});

/** DUAL_PROMO_CARDS — two side-by-side promo tiles. Each tile uses
 *  the same shape as a wide promo banner minus the mobile variant. */
const dualPromoCardSchema = z.object({
  imageUrl:    z.string().trim().max(500).default(''),
  imageAlt:    z.string().trim().max(200).default(''),
  headline:    z.string().trim().max(120).default(''),
  subheadline: z.string().trim().max(240).default(''),
  cta:         ctaSchema,
  theme:       themeSchema,
}).default({});
const dualPromoCardsConfigSchema = z.object({
  heading:    z.string().trim().max(120).default(''),
  left:       dualPromoCardSchema,
  right:      dualPromoCardSchema,
}).default({});

/** BRAND_SHOWCASE — a hero brand + a scrolling/static logos band. */
const brandShowcaseConfigSchema = z.object({
  heading:    z.string().trim().max(120).default('Discover leading brands'),
  subheading: z.string().trim().max(240).default(''),
  source:     z.enum(['auto', 'manual']).default('auto'),
  brandIds:   z.array(z.string().trim().min(1).max(64)).default([]),
  maxItems:   z.number().int().min(3).max(48).default(12),
  scrollMode: z.enum(['scroll', 'static']).default('static'),
}).default({});

/** STORE_METRICS — reads from the HomepageMetric table directly. */
const storeMetricsConfigSchema = z.object({
  heading:    z.string().trim().max(120).default(''),
  subheading: z.string().trim().max(240).default(''),
  theme:      themeSchema,
}).default({});

/** WHY_SHOP_WITH_US — admin-editable trust cards. */
const whyShopCardSchema = z.object({
  title:       z.string().trim().min(1).max(60),
  description: z.string().trim().max(240).default(''),
  iconUrl:     z.string().trim().max(500).default(''),
});
const whyShopWithUsConfigSchema = z.object({
  heading:    z.string().trim().max(120).default('Why shop with us'),
  subheading: z.string().trim().max(240).default(''),
  cards:      z.array(whyShopCardSchema).max(8).default([]),
}).default({});

/** BRANCHES — reads from the HomepageBranch table directly. */
const branchesConfigSchema = z.object({
  heading:    z.string().trim().max(120).default('Visit our stores'),
  subheading: z.string().trim().max(240).default(''),
  maxItems:   z.number().int().min(1).max(24).default(6),
}).default({});

/** NEWSLETTER — Phase 1 stub. Subscription wiring lands in Phase 2. */
const newsletterConfigSchema = z.object({
  heading:        z.string().trim().max(120).default('Stay in the loop'),
  description:    z.string().trim().max(400).default('Be the first to know about new products, offers, and seasonal deals.'),
  ctaLabel:       z.string().trim().max(60).default('Subscribe'),
  backgroundUrl:  z.string().trim().max(500).default(''),
}).default({});

// MOST_RATED_PRODUCTS + TRENDING_PRODUCTS share the same config shape
// as PRODUCT_COLLECTION (they're convenience aliases that pre-fill
// the `source.mode` on creation).
const aliasProductCollectionConfigSchema = productCollectionConfigSchema;

// ── Public dispatch table ────────────────────────────────────────────────

/** Map kind → its Zod schema. The keys here MUST cover every value of
 *  `HOMEPAGE_SECTION_KINDS` — TS will complain at compile time if a
 *  new kind lands without a schema (the Record type enforces it). */
export const SECTION_CONFIG_SCHEMAS: Record<HomepageSectionKind, z.ZodTypeAny> = {
  HERO:                  heroConfigSchema,
  FEATURED_BRANDS:       featuredBrandsConfigSchema,
  TOP_CATEGORIES:        topCategoriesConfigSchema,
  PRODUCT_COLLECTION:    productCollectionConfigSchema,
  WIDE_PROMO_BANNER:     widePromoBannerConfigSchema,
  DUAL_PROMO_CARDS:      dualPromoCardsConfigSchema,
  BRAND_SHOWCASE:        brandShowcaseConfigSchema,
  STORE_METRICS:         storeMetricsConfigSchema,
  WHY_SHOP_WITH_US:      whyShopWithUsConfigSchema,
  BRANCHES:              branchesConfigSchema,
  NEWSLETTER:            newsletterConfigSchema,
  MOST_RATED_PRODUCTS:   aliasProductCollectionConfigSchema,
  TRENDING_PRODUCTS:     aliasProductCollectionConfigSchema,
};

/** Inferred config type for each kind. Discriminated union over kind
 *  so consumers can switch / narrow safely. */
export type HomepageSectionConfig =
  | { kind: 'HERO';                config: z.infer<typeof heroConfigSchema> }
  | { kind: 'FEATURED_BRANDS';     config: z.infer<typeof featuredBrandsConfigSchema> }
  | { kind: 'TOP_CATEGORIES';      config: z.infer<typeof topCategoriesConfigSchema> }
  | { kind: 'PRODUCT_COLLECTION';  config: z.infer<typeof productCollectionConfigSchema> }
  | { kind: 'WIDE_PROMO_BANNER';   config: z.infer<typeof widePromoBannerConfigSchema> }
  | { kind: 'DUAL_PROMO_CARDS';    config: z.infer<typeof dualPromoCardsConfigSchema> }
  | { kind: 'BRAND_SHOWCASE';      config: z.infer<typeof brandShowcaseConfigSchema> }
  | { kind: 'STORE_METRICS';       config: z.infer<typeof storeMetricsConfigSchema> }
  | { kind: 'WHY_SHOP_WITH_US';    config: z.infer<typeof whyShopWithUsConfigSchema> }
  | { kind: 'BRANCHES';            config: z.infer<typeof branchesConfigSchema> }
  | { kind: 'NEWSLETTER';          config: z.infer<typeof newsletterConfigSchema> }
  | { kind: 'MOST_RATED_PRODUCTS'; config: z.infer<typeof productCollectionConfigSchema> }
  | { kind: 'TRENDING_PRODUCTS';   config: z.infer<typeof productCollectionConfigSchema> };

// ── Safe parsing ─────────────────────────────────────────────────────────

export interface SafeParseResultOk  { ok: true;  config: unknown }
export interface SafeParseResultErr { ok: false; issues: z.ZodIssue[] }

/** Parse + validate a (kind, raw-config) pair without throwing.
 *  - `raw` may be a JSON string from the DB OR an object from the
 *    admin form. Both are accepted; bad JSON yields `{}` (so the
 *    schema's per-field defaults take over).
 *  - Returns the canonical defaults-applied object on success. */
export function safeParseConfig(kind: string, raw: unknown): SafeParseResultOk | SafeParseResultErr {
  if (!isHomepageSectionKind(kind)) {
    return { ok: false, issues: [{ code: 'custom', path: ['kind'], message: 'Unknown section kind.' } as z.ZodIssue] };
  }
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try { candidate = JSON.parse(raw); } catch { candidate = {}; }
  }
  if (candidate === null || candidate === undefined) candidate = {};
  const schema = SECTION_CONFIG_SCHEMAS[kind];
  const r = schema.safeParse(candidate);
  if (!r.success) return { ok: false, issues: r.error.issues };
  return { ok: true, config: r.data };
}

/** Throwing variant — the service layer calls this only after
 *  `safeParseConfig` has run. */
export function parseConfigOrThrow(kind: HomepageSectionKind, raw: unknown): unknown {
  const r = safeParseConfig(kind, raw);
  if (!r.ok) {
    throw new ValidationError(`Invalid config for ${kind}: ${r.issues.map((i) => i.message).join('; ')}`, { code: 'INVALID_SECTION_CONFIG', context: { kind, issues: r.issues } });
  }
  return r.config;
}
