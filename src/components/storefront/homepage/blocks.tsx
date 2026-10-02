/**
 * Homepage CMS — render blocks. Item 18 Phase 1.
 *
 *   One block component per section kind. All blocks are SERVER
 *   components — they receive fully resolved data from the service
 *   layer and emit pure HTML. Client interactivity (the hero
 *   carousel) is wrapped in a thin client island.
 *
 *   The dispatcher `<HomepageRenderer sections={...}>` switches over
 *   `section.kind` and picks the right block.
 *
 *   Visual style: matches the existing storefront vocabulary
 *   (`max-w-7xl`, `bg-slate-50`, `rounded-xl`, tap-target buttons).
 *   Sections that need a tinted background use the `themeBg(...)`
 *   helper so the palette stays consistent.
 */
import Link from 'next/link';
import HeroCarousel from '../HeroCarousel';
import BrandLogo from '../BrandLogo';
import CategoryImage from '../CategoryImage';
import ProductCard from '../ProductCard';
import NewsletterForm from './NewsletterForm';
import { listVisibleBanners } from '@/lib/cms/heroBanners';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { DEFAULT_STORE_CONFIG } from '@/lib/config';
import type {
  ResolvedSection, ProductCardData, BrandTileData,
  CategoryTileData, MetricData, BranchData,
} from '@/lib/cms/homepage';

// ── Theme helper ─────────────────────────────────────────────────────────

function themeBg(theme?: unknown): string {
  switch (theme) {
    case 'sky':      return 'bg-sky-50';
    case 'amber':    return 'bg-amber-50';
    case 'emerald':  return 'bg-emerald-50';
    case 'rose':     return 'bg-rose-50';
    case 'slate':    return 'bg-slate-100';
    default:         return '';
  }
}

function SectionHeading({ heading, subheading }: { heading?: string; subheading?: string }) {
  if (!heading && !subheading) return null;
  return (
    <header className="mb-4">
      {heading && <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">{heading}</h2>}
      {subheading && <p className="mt-1 text-sm text-slate-600">{subheading}</p>}
    </header>
  );
}

function CtaButton({ label, href }: { label?: string; href?: string }) {
  if (!label || !href) return null;
  return (
    <Link
      href={href}
      className="tap-target inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
    >
      {label}
    </Link>
  );
}

// ── Block: HERO ─────────────────────────────────────────────────────────

/** Async server component — fetches the live hero banner list on
 *  demand. Phase 1 keeps the existing CMS-backed HeroCarousel intact
 *  to avoid regressions. */
export async function HeroBlock() {
  const [banners, cfg] = await Promise.all([
    listVisibleBanners(),
    getStoreConfig(),
  ]);
  const heroConfig = (cfg as unknown as { hero?: typeof DEFAULT_STORE_CONFIG.hero }).hero
    ?? DEFAULT_STORE_CONFIG.hero;
  return <HeroCarousel banners={banners} config={heroConfig} />;
}

// ── Block: FEATURED_BRANDS ──────────────────────────────────────────────

interface FeaturedBrandsConfig {
  heading?:    string;
  subheading?: string;
  brands:      BrandTileData[];
}
export function FeaturedBrandsBlock({ heading, subheading, brands }: FeaturedBrandsConfig) {
  if (brands.length === 0) return null;
  return (
    <section className="mx-auto max-w-7xl px-4 py-8" aria-label={heading ?? 'Featured brands'}>
      <SectionHeading heading={heading} subheading={subheading} />
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-6">
        {brands.map((b) => (
          <li key={b.id}>
            <Link
              href={`/search?brand=${encodeURIComponent(b.slug)}`}
              className="flex items-center justify-center rounded-lg border border-slate-200 bg-white p-3 transition hover:border-brand-300 hover:shadow-sm"
              aria-label={`Browse ${b.name}`}
            >
              <BrandLogo logoUrl={b.logoUrl} name={b.name} size={56} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Block: TOP_CATEGORIES ───────────────────────────────────────────────

interface TopCategoriesConfig {
  heading?:    string;
  subheading?: string;
  layout?:     'tiles' | 'compact';
  categories:  CategoryTileData[];
}
export function TopCategoriesBlock({ heading, subheading, layout, categories }: TopCategoriesConfig) {
  if (categories.length === 0) return null;
  const isCompact = layout === 'compact';
  return (
    <section className="mx-auto max-w-7xl px-4 py-8" aria-label={heading ?? 'Top categories'}>
      <SectionHeading heading={heading} subheading={subheading} />
      <ul className={isCompact
        ? 'grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6'
        : 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5'}>
        {categories.map((c) => (
          <li key={c.id}>
            <Link
              href={`/c/${c.slug}`}
              className="group block overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-brand-300 hover:shadow-md"
            >
              {!isCompact && <CategoryImage imageUrl={c.imageUrl} name={c.name} aspect="tile" />}
              <div className={`p-3 text-center ${isCompact ? 'py-4' : ''}`}>
                <p className="text-sm font-semibold text-slate-900 group-hover:text-brand-700">{c.name}</p>
                <p className="text-xs text-slate-500">{c.productCount} products</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Block: PRODUCT_COLLECTION (+ MOST_RATED + TRENDING) ─────────────────

interface ProductCollectionConfig {
  heading?:    string;
  subheading?: string;
  theme?:      string;
  cta?:        { label?: string; href?: string };
  products:    ProductCardData[];
}
export function ProductCollectionBlock({ heading, subheading, theme, cta, products }: ProductCollectionConfig) {
  if (products.length === 0) return null;
  const bg = themeBg(theme);
  return (
    <section className={bg} aria-label={heading ?? 'Product collection'}>
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4 flex items-end justify-between gap-3">
          <SectionHeading heading={heading} subheading={subheading} />
          <div className="shrink-0"><CtaButton label={cta?.label} href={cta?.href} /></div>
        </div>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {products.map((p) => (
            <li key={p.id}>
              <ProductCard p={{
                id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
                mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
                imageUrl: p.imageUrl,
                brand:    p.brand,
                category: p.category,
                stock:    p.stock,
                hasVariants: p.hasVariants,
              }} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── Block: WIDE_PROMO_BANNER ────────────────────────────────────────────

interface WidePromoConfig {
  imageDesktopUrl?: string;
  imageMobileUrl?:  string;
  imageAlt?:        string;
  headline?:        string;
  subheadline?:     string;
  cta?:             { label?: string; href?: string };
}
export function WidePromoBannerBlock({
  imageDesktopUrl, imageMobileUrl, imageAlt,
  headline, subheadline, cta,
}: WidePromoConfig) {
  const hasImage = (imageDesktopUrl ?? '').trim() !== '';
  return (
    <section className="mx-auto max-w-7xl px-4 py-6" aria-label={headline ?? 'Promotion'}>
      <div className="relative overflow-hidden rounded-2xl bg-slate-100">
        {hasImage && (
          <picture>
            {imageMobileUrl && <source media="(max-width: 640px)" srcSet={imageMobileUrl} />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageDesktopUrl}
              alt={imageAlt ?? headline ?? 'Promotional banner'}
              className="h-48 w-full object-cover sm:h-64 lg:h-80"
            />
          </picture>
        )}
        {(headline || subheadline || cta?.label) && (
          <div className={`${hasImage ? 'absolute inset-0' : ''} flex flex-col items-start justify-center gap-2 p-6 sm:p-10 ${hasImage ? 'bg-gradient-to-r from-black/60 via-black/30 to-transparent text-white' : 'text-slate-900'}`}>
            {headline    && <h2 className="text-xl font-bold sm:text-3xl">{headline}</h2>}
            {subheadline && <p className="max-w-md text-sm sm:text-base">{subheadline}</p>}
            <div className="mt-2"><CtaButton label={cta?.label} href={cta?.href} /></div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Block: DUAL_PROMO_CARDS ─────────────────────────────────────────────

interface DualPromoCardData {
  imageUrl?:    string;
  imageAlt?:    string;
  headline?:    string;
  subheadline?: string;
  cta?:         { label?: string; href?: string };
}
function PromoCard({ card }: { card: DualPromoCardData }) {
  const hasImage = (card.imageUrl ?? '').trim() !== '';
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-100">
      {hasImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.imageUrl}
          alt={card.imageAlt ?? card.headline ?? 'Promotion'}
          className="h-40 w-full object-cover sm:h-56"
        />
      )}
      <div className={`${hasImage ? 'absolute inset-0' : ''} flex flex-col items-start justify-center gap-2 p-5 ${hasImage ? 'bg-gradient-to-r from-black/55 via-black/25 to-transparent text-white' : 'text-slate-900'}`}>
        {card.headline    && <h3 className="text-lg font-bold sm:text-xl">{card.headline}</h3>}
        {card.subheadline && <p className="text-sm">{card.subheadline}</p>}
        <CtaButton label={card.cta?.label} href={card.cta?.href} />
      </div>
    </div>
  );
}
export function DualPromoCardsBlock({ heading, left, right }: { heading?: string; left: DualPromoCardData; right: DualPromoCardData }) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-6" aria-label={heading ?? 'Promotional cards'}>
      <SectionHeading heading={heading} />
      <div className="grid gap-4 md:grid-cols-2">
        <PromoCard card={left} />
        <PromoCard card={right} />
      </div>
    </section>
  );
}

// ── Block: BRAND_SHOWCASE ───────────────────────────────────────────────

export function BrandShowcaseBlock({
  heading, subheading, scrollMode, brands,
}: {
  heading?: string; subheading?: string;
  scrollMode?: 'scroll' | 'static';
  brands: BrandTileData[];
}) {
  if (brands.length === 0) return null;
  if (scrollMode === 'scroll') {
    return (
      <section className="bg-white py-8" aria-label={heading ?? 'Brand showcase'}>
        <div className="mx-auto max-w-7xl px-4">
          <SectionHeading heading={heading} subheading={subheading} />
        </div>
        {/* Auto-scrolling band — pure CSS, respects prefers-reduced-motion via global utility. */}
        <div className="relative overflow-hidden">
          <ul className="flex animate-[scroll-x_30s_linear_infinite] gap-6 px-4 motion-reduce:animate-none">
            {[...brands, ...brands].map((b, i) => (
              <li key={`${b.id}-${i}`} className="shrink-0">
                <Link
                  href={`/search?brand=${encodeURIComponent(b.slug)}`}
                  className="flex h-20 w-32 items-center justify-center rounded-lg border border-slate-200 bg-white px-3"
                  aria-label={`Browse ${b.name}`}
                >
                  <BrandLogo logoUrl={b.logoUrl} name={b.name} size={56} />
                </Link>
              </li>
            ))}
          </ul>
          <style>{`@keyframes scroll-x { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
        </div>
      </section>
    );
  }
  // Static grid — same as FEATURED_BRANDS but with subheading + bigger logo.
  return (
    <section className="mx-auto max-w-7xl px-4 py-8" aria-label={heading ?? 'Brand showcase'}>
      <SectionHeading heading={heading} subheading={subheading} />
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {brands.map((b) => (
          <li key={b.id}>
            <Link
              href={`/search?brand=${encodeURIComponent(b.slug)}`}
              className="flex h-20 items-center justify-center rounded-lg border border-slate-200 bg-white px-3"
              aria-label={`Browse ${b.name}`}
            >
              <BrandLogo logoUrl={b.logoUrl} name={b.name} size={64} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Block: STORE_METRICS ────────────────────────────────────────────────

export function StoreMetricsBlock({
  heading, subheading, theme, metrics,
}: {
  heading?: string; subheading?: string; theme?: string;
  metrics: MetricData[];
}) {
  if (metrics.length === 0) return null;
  return (
    <section className={`${themeBg(theme)} py-10`} aria-label={heading ?? 'Trust metrics'}>
      <div className="mx-auto max-w-7xl px-4">
        <SectionHeading heading={heading} subheading={subheading} />
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {metrics.map((m) => (
            <li
              key={m.id}
              className="rounded-xl border border-slate-200 bg-white p-5 text-center shadow-sm"
            >
              {m.iconUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={m.iconUrl} alt="" className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
              )}
              <p className="text-3xl font-extrabold tabular-nums text-brand-700">{m.value}</p>
              <p className="mt-1 text-sm font-semibold text-slate-700">{m.label}</p>
              {m.caption && <p className="mt-0.5 text-xs text-slate-500">{m.caption}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── Block: WHY_SHOP_WITH_US ─────────────────────────────────────────────

export function WhyShopWithUsBlock({
  heading, subheading, cards,
}: {
  heading?: string; subheading?: string;
  cards: Array<{ title: string; description?: string; iconUrl?: string }>;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="mx-auto max-w-7xl px-4 py-10" aria-label={heading ?? 'Why shop with us'}>
      <SectionHeading heading={heading} subheading={subheading} />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card, i) => (
          <li key={`${card.title}-${i}`} className="rounded-xl border border-slate-200 bg-white p-5">
            {card.iconUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={card.iconUrl} alt="" aria-hidden="true" className="mb-2 h-8 w-8" />
            )}
            <h3 className="text-sm font-bold text-slate-900">{card.title}</h3>
            {card.description && <p className="mt-1 text-xs text-slate-600">{card.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Block: BRANCHES ─────────────────────────────────────────────────────

export function BranchesBlock({
  heading, subheading, branches,
}: {
  heading?: string; subheading?: string;
  branches: BranchData[];
}) {
  if (branches.length === 0) return null;
  return (
    <section className="mx-auto max-w-7xl px-4 py-10" aria-label={heading ?? 'Store locations'}>
      <SectionHeading heading={heading} subheading={subheading} />
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {branches.map((b) => {
          const inner = (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-brand-300 hover:shadow-sm">
              {b.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={b.imageUrl} alt={`${b.name} store`} className="aspect-[16/9] w-full object-cover" />
              ) : (
                <div className="grid aspect-[16/9] w-full place-items-center bg-slate-100 text-slate-400">Store photo</div>
              )}
              <div className="p-4">
                <p className="font-semibold text-slate-900">{b.name}</p>
                <p className="text-sm text-slate-600">{b.city}</p>
                {b.address && <p className="mt-1 text-xs text-slate-500">{b.address}</p>}
                {b.phone   && <p className="mt-0.5 text-xs text-slate-500">{b.phone}</p>}
              </div>
            </div>
          );
          return (
            <li key={b.id}>
              {b.linkUrl ? <a href={b.linkUrl} target="_blank" rel="noopener noreferrer">{inner}</a> : inner}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Block: NEWSLETTER ───────────────────────────────────────────────────

export function NewsletterBlock({
  heading, description, ctaLabel, backgroundUrl,
}: {
  heading?: string; description?: string; ctaLabel?: string; backgroundUrl?: string;
}) {
  const bgStyle = backgroundUrl
    ? { backgroundImage: `linear-gradient(rgba(15,23,42,0.7), rgba(15,23,42,0.7)), url("${backgroundUrl}")` }
    : { background: 'linear-gradient(135deg, hsl(220, 60%, 25%), hsl(220, 60%, 15%))' };
  return (
    <section
      className="mx-auto my-6 max-w-7xl rounded-2xl bg-cover bg-center px-6 py-12 text-white"
      style={bgStyle}
      aria-label={heading ?? 'Newsletter'}
    >
      <h2 className="text-2xl font-bold sm:text-3xl">{heading || 'Stay in the loop'}</h2>
      {description && <p className="mt-2 max-w-xl text-sm text-white/90">{description}</p>}
      {/* Item 18 Phase 2 — real inline subscribe form, POSTs to
          /api/newsletter/subscribe. Uniform-success response prevents
          enumeration of which addresses already have an account. */}
      <NewsletterForm ctaLabel={ctaLabel || 'Subscribe'} />
    </section>
  );
}
