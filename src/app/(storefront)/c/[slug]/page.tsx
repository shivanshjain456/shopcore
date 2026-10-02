/**
 * Category browse page with filters, sort, pagination.
 * URL-driven: ?brand=dell,hp&min=20000&max=80000&sort=price_asc&page=2
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db/client';
import { listProducts, getBrands } from '@/lib/catalog/queries';
import ProductGrid from '@/components/storefront/ProductGrid';
import type { ProductCardData } from '@/components/storefront/ProductCard';
import Pagination from '@/components/Pagination';
import PaginationSeoLinks from '@/components/seo/PaginationSeoLinks';
import { buildPaginationSeo } from '@/lib/seo/paginationSeo';
import { getStoreConfig } from '@/lib/storeConfig';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { slug: string };
  searchParams: Record<string, string | undefined>;
}

export default async function CategoryPage({ params, searchParams }: PageProps) {
  const cat = await prisma.category.findUnique({ where: { slug: params.slug } });
  if (!cat || !cat.isActive) notFound();

  const brandSlugs = (searchParams.brand ?? '').split(',').filter(Boolean);
  const min = searchParams.min ? Math.max(0, Math.floor(Number(searchParams.min))) : undefined;
  const max = searchParams.max ? Math.max(0, Math.floor(Number(searchParams.max))) : undefined;
  const sort = (searchParams.sort as 'price_asc' | 'price_desc' | 'newest' | 'name' | 'relevance' | undefined) ?? 'relevance';
  const inStock = searchParams.instock === '1';
  const page = Math.max(1, Number(searchParams.page ?? '1') || 1);

  const [brands, result] = await Promise.all([
    getBrands(),
    listProducts({
      categorySlug: params.slug,
      brandSlugs,
      minPaise: min !== undefined ? min * 100 : undefined,
      maxPaise: max !== undefined ? max * 100 : undefined,
      sort,
      inStockOnly: inStock,
      page,
      pageSize: 24,
    }),
  ]);

  // Spec §2.8 — page > totalPages → redirect to page 1 (preserve filters).
  if (result.total > 0 && page > result.pageCount) {
    const sp = new URLSearchParams(searchParams as Record<string, string>);
    sp.delete('page');
    const qs = sp.toString();
    redirect(`/c/${params.slug}${qs ? `?${qs}` : ''}`);
  }

  // Item 12 Phase 2 — SEO: canonical + rel=prev/next + per-page noindex.
  const cfg = await getStoreConfig();
  const seo = buildPaginationSeo({
    origin:       env.APP_URL.replace(/\/+$/, ''),
    basePath:     `/c/${params.slug}`,
    searchParams,
    currentPage:  result.page,
    totalPages:   result.pageCount,
    config:       cfg,
  });

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <PaginationSeoLinks {...seo} />
      <nav className="text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">Home</Link> / <span className="text-slate-700">{cat.name}</span>
      </nav>
      {/* Item 17 — category banner above the title when set. Bare <img>
          is fine here; the asset is same-origin upload-served and we
          want fluid full-width rendering rather than Next.js sizing. */}
      {(cat as { bannerUrl?: string | null }).bannerUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={(cat as { bannerUrl: string }).bannerUrl}
          alt={`${cat.name} banner`}
          className="mt-3 aspect-[16/5] w-full rounded-xl object-cover"
        />
      )}
      <h1 className="mt-2 text-2xl font-bold text-slate-900">{cat.name}</h1>
      {(cat as { description?: string | null }).description && (
        <p className="mt-1 text-sm text-slate-600">{(cat as { description: string }).description}</p>
      )}
      <p className="text-sm text-slate-600">{result.total} product{result.total === 1 ? '' : 's'}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* Filters */}
        <aside className="space-y-6">
          <form method="GET" className="space-y-5">
            {/* sort + instock */}
            <div>
              <label className="text-xs font-semibold uppercase text-slate-600">Sort by</label>
              <select name="sort" defaultValue={sort} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
                <option value="relevance">Featured first</option>
                <option value="newest">Newest</option>
                <option value="price_asc">Price: low → high</option>
                <option value="price_desc">Price: high → low</option>
                <option value="name">Name A → Z</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase text-slate-600">Price (₹)</label>
              <div className="mt-1 flex gap-2">
                <input name="min" defaultValue={min ?? ''} placeholder="Min" inputMode="numeric"
                       className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                <input name="max" defaultValue={max ?? ''} placeholder="Max" inputMode="numeric"
                       className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase text-slate-600">Brand</p>
              <div className="mt-1 max-h-56 space-y-1 overflow-y-auto pr-1">
                {brands.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="brand" value={b.slug} defaultChecked={brandSlugs.includes(b.slug)} />
                    <span>{b.name}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-slate-400">Multiple brands ok (server combines)</p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="instock" value="1" defaultChecked={inStock} />
              In stock only
            </label>

            <div className="flex gap-2">
              <button type="submit" className="flex-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                Apply
              </button>
              <Link href={`/c/${params.slug}`} className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
                Clear
              </Link>
            </div>
          </form>
        </aside>

        {/* Grid */}
        <div>
          {result.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center">
              <p className="font-semibold">No products match these filters.</p>
              <Link href={`/c/${params.slug}`} className="mt-2 inline-block text-sm font-semibold text-brand-700 hover:underline">
                Clear filters
              </Link>
            </div>
          ) : (
            <ProductGrid
              items={result.items.map<ProductCardData>((p) => ({
                id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
                mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
                imageUrl: p.images[0]?.url ?? null,
                brand: p.brand ? { name: p.brand.name } : null,
                category: p.category ? { name: p.category.name, slug: p.category.slug } : null,
                hasVariants: p.variants.length > 0,
                stock: p.stock,
              }))}
              pagination={{
                total: result.total,
                page: result.page,
                pageSize: result.pageSize,
                totalPages: result.pageCount,
                hasNextPage: result.page < result.pageCount,
                hasPrevPage: result.page > 1,
              }}
              infiniteScroll={cfg.performance.paginationInfiniteScrollEnabled}
              pageEndpoint="/api/products"
              baseSearchParams={{
                category: params.slug,
                brand:   brandSlugs.length ? brandSlugs.join(',') : undefined,
                min:     min !== undefined ? String(min) : undefined,
                max:     max !== undefined ? String(max) : undefined,
                sort,
                instock: inStock ? '1' : undefined,
              }}
            />
          )}

          {/* Pagination (Item 12) */}
          <Pagination
            currentPage={result.page}
            totalPages={result.pageCount}
            pageSize={result.pageSize}
            totalItems={result.total}
            basePath={`/c/${params.slug}`}
            searchParams={searchParams}
            jumpInputThreshold={cfg.performance.paginationJumpInputThreshold}
            keyboardNav
          />
        </div>
      </div>
    </main>
  );
}
