/**
 * Storefront home — hero, featured products, categories, and a top-rated strip.
 * Server-rendered for SEO + first-paint speed.
 */
import Link from 'next/link';
import ProductCard from '@/components/storefront/ProductCard';
import HeroCarousel from '@/components/storefront/HeroCarousel';
import { getFeaturedProducts, getCategoriesWithCounts, listProducts, getBrands } from '@/lib/catalog/queries';
import CategoryImage from '@/components/storefront/CategoryImage';
import BrandLogo from '@/components/storefront/BrandLogo';
import { listVisibleBanners } from '@/lib/cms/heroBanners';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { DEFAULT_STORE_CONFIG } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [featured, cats, latest, banners, cfg, brands] = await Promise.all([
    getFeaturedProducts(8),
    getCategoriesWithCounts(),
    listProducts({ sort: 'newest', pageSize: 8 }),
    listVisibleBanners(),
    getStoreConfig(),
    getBrands(),
  ]);
  // Item 17 — show the brand band when there are ≥3 brands; below that
  //   the band looks empty and we skip the section entirely.
  const brandsForBand = brands.slice(0, 12);
  // Use the admin-configured hero settings; fall back to in-code defaults
  // if the stored config predates Feature #15.
  const heroConfig = (cfg as unknown as { hero?: typeof DEFAULT_STORE_CONFIG.hero }).hero
    ?? DEFAULT_STORE_CONFIG.hero;

  return (
    <main>
      {/* ─────────────────────────────────────────────────────────────────
       *  Feature #15 — Hero Carousel
       *  CMS-managed banner slides rendered above the brand/value-prop
       *  band. Server-rendered (initial banners flow with the SSR
       *  payload), then hydrated to a client component for autoplay /
       *  swipe / keyboard / arrow + dot navigation.
       *  ───────────────────────────────────────────────────────────── */}
      <HeroCarousel banners={banners} config={heroConfig} />

      {/* Brand / value-prop band (kept as the secondary brand statement). */}
      <section className="bg-gradient-to-br from-brand-50 via-white to-brand-50">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 lg:grid-cols-2 lg:py-16">
          <div className="flex flex-col justify-center">
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">India only</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">
              Laptops, desktops &amp; computer accessories — delivered nationwide.
            </h1>
            <p className="mt-4 max-w-xl text-slate-600">
              Genuine products, fair B2C pricing, and special bulk pricing for verified businesses.
              Pay easily via UPI QR. Track every order from your dashboard.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/c/laptops" className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700">
                Shop laptops
              </Link>
              <Link href="/b2b" className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                For business →
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-4 text-xs text-slate-500">
              <span>✓ Pan-India shipping</span>
              <span>✓ UPI / QR payments</span>
              <span>✓ Configurable returns</span>
              <span>✓ GST invoice on request</span>
            </div>
          </div>
          <div className="hidden lg:block">
            <div className="grid grid-cols-2 gap-4">
              {featured.slice(0, 4).map((p) => (
                <Link key={p.id} href={`/p/${p.slug}`} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                  {p.images[0]?.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.images[0].url} alt={p.name} className="aspect-[3/2] w-full object-cover" />
                  )}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Categories — Item 17: tile images via <CategoryImage> with
          designed fallback. */}
      <section className="mx-auto max-w-7xl px-4 py-10">
        <h2 className="text-lg font-bold text-slate-900">Shop by category</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {cats.map((c) => {
            const cat = c as { id: string; name: string; slug: string; imageUrl?: string | null; _count?: { products: number } };
            return (
              <Link key={cat.id} href={`/c/${cat.slug}`} className="group block overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-brand-300 hover:shadow-md">
                <CategoryImage imageUrl={cat.imageUrl} name={cat.name} aspect="tile" />
                <div className="p-3 text-center">
                  <p className="text-sm font-semibold text-slate-900 group-hover:text-brand-700">{cat.name}</p>
                  <p className="text-xs text-slate-500">{cat._count?.products ?? 0} products</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Brand band — Item 17. Shows real brand logos via <BrandLogo>
          (with deterministic initial-letter fallback) for the first 12
          active brands. Hidden when fewer than 3 brands exist. */}
      {brandsForBand.length >= 3 && (
        <section className="mx-auto max-w-7xl px-4 py-10">
          <h2 className="text-lg font-bold text-slate-900">Shop by brand</h2>
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-6">
            {brandsForBand.map((b) => (
              <Link
                key={b.id}
                href={`/search?brand=${encodeURIComponent(b.slug)}`}
                className="flex items-center justify-center rounded-lg border border-slate-200 bg-white p-3 transition hover:border-brand-300 hover:shadow-sm"
                aria-label={`Browse ${b.name}`}
              >
                <BrandLogo logoUrl={b.logoUrl} name={b.name} size={56} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Featured */}
      {featured.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex items-end justify-between">
            <h2 className="text-lg font-bold text-slate-900">Featured</h2>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {featured.map((p) => (
              <ProductCard key={p.id} p={{
                id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
                mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
                imageUrl: p.images[0]?.url ?? null,
                brand: p.brand ? { name: p.brand.name } : null,
                category: p.category ? { name: p.category.name, slug: p.category.slug } : null,
                stock: p.stock,
              }} />
            ))}
          </div>
        </section>
      )}

      {/* Latest */}
      {latest.items.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 py-6">
          <h2 className="text-lg font-bold text-slate-900">Latest additions</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {latest.items.map((p) => (
              <ProductCard key={p.id} p={{
                id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
                mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
                imageUrl: p.images[0]?.url ?? null,
                brand: p.brand ? { name: p.brand.name } : null,
                category: p.category ? { name: p.category.name, slug: p.category.slug } : null,
                hasVariants: p.variants.length > 0,
                stock: p.stock,
              }} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
