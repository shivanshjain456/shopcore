/**
 * Product detail page.
 *
 * Server-rendered. Variant selection + the live headline-price block both
 * live in the client component `ProductPriceAndPicker`, which calls the
 * same pure `selectVariantPrice()` selector that the server uses for the
 * initial render — so the displayed price can't drift from the variant's
 * actual price when the user changes selection.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProductBySlug, getRelatedProducts } from '@/lib/catalog/queries';
import { getCurrentUser } from '@/lib/auth/session';
import { effectivePricePaise, priceCtxForUser, rupees } from '@/lib/catalog/pricing';
import { prisma } from '@/lib/db/client';
import ProductCard from '@/components/storefront/ProductCard';
import ProductGallery from '@/components/storefront/ProductGallery';
import ProductPriceAndPicker from '@/components/storefront/ProductPriceAndPicker';
import CompareButton from '@/components/storefront/CompareButton';
import SubscribeWidget from '@/components/storefront/SubscribeWidget';
import ShareButton from '@/components/storefront/ShareButton';
import { findProductIdBySlug } from '@/lib/cms/productSlugAlias';
import { buildProductUrl } from '@/lib/share/productUrl';
import { env } from '@/lib/config';
import { getStoreConfig } from '@/lib/storeConfig';
import { isGalleryEnabled, isGalleryLazyLoadEnabled, readGalleryInteractionSettings } from '@/lib/cms/productGallery';

export const dynamic = 'force-dynamic';

/**
 * Feature #35 — Open Graph + Twitter Card + canonical URL.
 *
 *   Every product page ships:
 *     - title         → "{product} · {storeName}"
 *     - description   → shortDesc || a derived "from {price} · {brand}"
 *     - canonical     → buildProductUrl(slug)
 *     - openGraph     → type:product, image array, title, description, url
 *     - twitter       → summary_large_image card with the same image
 *
 *   Aliased slugs ALSO get metadata — but with the canonical URL pointing
 *   at the current slug. This prevents duplicate-content SEO penalties
 *   when a slug rename happens.
 */
export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const resolved = await findProductIdBySlug(params.slug);
  if (!resolved) {
    return { title: 'Product not found' };
  }
  const p = await prisma.product.findUnique({
    where: { id: resolved.productId },
    include: {
      // Item 19 — only ACTIVE images surface in OG previews so an admin
      // soft-disabling a bad shot also takes it off WhatsApp/Twitter.
      images: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 4 },
      brand: { select: { name: true } },
    },
  });
  if (!p) return { title: 'Product not found' };

  // Item 17 — store name from admin config so OG previews + tab
  //   titles reflect whatever the operator branded the storefront as.
  const cfg = await getStoreConfig();
  const storeName = ((cfg.store as { name?: string }).name ?? '').trim() || 'ShopCore';

  const canonical = buildProductUrl(resolved.currentSlug);
  const title = `${p.name} · ${storeName}`;
  // Open Graph descriptions are capped around 200 chars in most previews.
  const desc  = (p.metaDesc ?? p.shortDesc ??
                 `${p.brand ? p.brand.name + ' · ' : ''}from ${rupees(p.pricePaise)} · GST invoice available`)
                .slice(0, 200);
  // Item 17 — fall back to the dynamic /opengraph-image route
  //   (which itself uses store.ogImageUrl OR a generated card) so
  //   we never link a missing static file. Absolute URLs only —
  //   relative paths don't unfurl in WhatsApp / iMessage previews.
  const ogImages = (p.images.length
    ? p.images.map((im) => im.url)
    : ['/opengraph-image']
  ).map((u) => (u.startsWith('http') ? u : `${env.APP_URL.replace(/\/+$/, '')}${u.startsWith('/') ? '' : '/'}${u}`));

  return {
    title,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: 'website',          // 'product' is not in next/Metadata's typed enum
      title,
      description: desc,
      url: canonical,
      siteName: storeName,
      locale: 'en_IN',
      images: ogImages.map((url) => ({ url, alt: p.name })),
    },
    twitter: {
      card: 'summary_large_image',
      title, description: desc, images: ogImages.slice(0, 1),
    },
    robots: { index: p.isActive, follow: true },
  };
}

export default async function ProductPage({ params }: { params: { slug: string } }) {
  // Feature #35 — slug-alias resolution. If the URL slug isn't the
  // product's current canonical slug but matches an alias, 301-style
  // redirect to the canonical URL so search engines + share previews
  // converge on one URL.
  const resolved = await findProductIdBySlug(params.slug);
  if (!resolved) notFound();
  if (resolved.isAlias) {
    // Preserve query (UTMs) on the redirect so analytics keep working.
    redirect(`/p/${encodeURIComponent(resolved.currentSlug)}`);
  }

  const p = await getProductBySlug(resolved.currentSlug);
  if (!p || !p.isActive) notFound();

  const user = await getCurrentUser();
  const tier = user?.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const ctx = priceCtxForUser(user, tier);

  // Item 19 — gallery feature flags read once on the server so the
  // gallery component stays pure / SSR-only. `galleryEnabled` controls
  // whether the thumb rail renders; `lazyLoadEnabled` controls the
  // `loading="lazy"` attribute on non-primary thumbnails.
  const cfg = await getStoreConfig();
  const galleryOn  = isGalleryEnabled(cfg);
  const galleryLZ  = isGalleryLazyLoadEnabled(cfg);
  // Item 20 — interaction settings (master switch + zoom + fullscreen
  // + loop + transition duration + thumbnail position).
  const galleryInteractions = readGalleryInteractionSettings(cfg);

  const basePrice = effectivePricePaise(p, ctx);
  const related = await getRelatedProducts(p.id, p.categoryId, 4);

  const variantsForClient = p.variants.map((v) => ({
    id: v.id,
    name: v.name,
    attributes: v.attributes,
    pricePaise: effectivePricePaise(v, ctx),
    mrpPaise: v.mrpPaise,
    stock: v.stock,
    isActive: v.isActive !== false,
  }));

  // Default to the first IN-STOCK variant for nicer UX. The same selector
  // runs client-side on every change, so this is just the SSR seed.
  const initialVariantId =
    variantsForClient.find((v) => v.stock > 0)?.id
    ?? variantsForClient[0]?.id
    ?? null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <nav className="text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">Home</Link> /{' '}
        <Link href={`/c/${p.category.slug}`} className="hover:text-brand-700">{p.category.name}</Link> /{' '}
        <span className="text-slate-700">{p.name}</span>
      </nav>

      <div className="mt-4 grid gap-8 lg:grid-cols-2">
        <ProductGallery
          productName={p.name}
          galleryEnabled={galleryOn}
          lazyLoadEnabled={galleryLZ}
          interactionSettings={galleryInteractions}
          images={p.images.map((im) => ({
            id:        im.id,
            productId: p.id,
            url:       im.url,
            alt:       im.alt ?? null,
            sortOrder: im.sortOrder,
            isPrimary: im.isPrimary,
            isActive:  true, // queries.ts already filters to isActive:true
            // queries.ts strips createdAt/updatedAt from this select —
            // the gallery component never reads them in render, so we
            // pass placeholder Date values to keep the type contract.
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }))}
        />

        <div>
          {p.brand && <p className="text-xs uppercase tracking-wider text-slate-500">{p.brand.name}</p>}
          <h1 className="mt-1 text-2xl font-bold text-slate-900 lg:text-3xl">{p.name}</h1>
          {p.shortDesc && <p className="mt-1 text-slate-600">{p.shortDesc}</p>}

          <ProductPriceAndPicker
            product={{
              id: p.id,
              pricePaise: basePrice,
              mrpPaise: p.mrpPaise,
              stock: p.stock,
              gstRate: p.gstRate,
              isB2B: user?.role === 'B2B',
            }}
            variants={variantsForClient}
            initialSelectedId={initialVariantId}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <CompareButton productId={p.id} />
            <SubscribeWidget productId={p.id} variants={variantsForClient.map((v) => ({ id: v.id, name: v.name }))} />
            {/* Feature #35 — native share + fallback modal with Copy Link /
                WhatsApp / Telegram / Facebook / X / Email. UTM-stamped per
                channel via the central productUrl service. */}
            <ShareButton
              slug={p.slug}
              productName={p.name}
              description={p.shortDesc ?? undefined}
              imageUrl={p.images[0]?.url ?? null}
              priceText={`from ${rupees(basePrice)}`}
            />
          </div>

          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-semibold">Trust</p>
            <ul className="mt-2 space-y-1 text-slate-600">
              <li>✓ Ships across India · UPI / QR payment at checkout</li>
              <li>✓ Returns / exchanges per store policy</li>
              <li>✓ GST invoice available · HSN {p.hsnCode ?? '—'}</li>
            </ul>
          </div>

          {p.description && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-slate-900">About this product</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{p.description}</p>
            </div>
          )}

          {p.reviews.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-slate-900">Customer reviews ({p.reviews.length})</h2>
              <div className="mt-2 space-y-3">
                {p.reviews.map((r) => (
                  <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                    <p className="text-sm font-semibold">
                      {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} <span className="ml-2 font-normal text-slate-500">{r.user.firstName} {r.user.lastName[0]}.</span>
                    </p>
                    {r.title && <p className="text-sm font-semibold">{r.title}</p>}
                    {r.body && <p className="text-sm text-slate-700">{r.body}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-bold text-slate-900">You may also like</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {related.map((r) => (
              <ProductCard key={r.id} p={{
                id: r.id, slug: r.slug, name: r.name, shortDesc: r.shortDesc,
                mrpPaise: r.mrpPaise, pricePaise: r.pricePaise,
                imageUrl: r.images[0]?.url ?? null,
                brand: r.brand ? { name: r.brand.name } : null,
              }} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
