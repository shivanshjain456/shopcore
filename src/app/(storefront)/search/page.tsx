import { redirect } from 'next/navigation';
import { listProducts } from '@/lib/catalog/queries';
import ProductGrid from '@/components/storefront/ProductGrid';
import type { ProductCardData } from '@/components/storefront/ProductCard';
import Pagination from '@/components/Pagination';
import PaginationSeoLinks from '@/components/seo/PaginationSeoLinks';
import { buildPaginationSeo } from '@/lib/seo/paginationSeo';
import { getStoreConfig } from '@/lib/storeConfig';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function SearchPage({ searchParams }: { searchParams: { q?: string; page?: string; sort?: string } }) {
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, Number(searchParams.page ?? '1') || 1);
  const sort = (searchParams.sort as 'price_asc' | 'price_desc' | 'newest' | 'name' | 'relevance' | undefined) ?? 'relevance';

  const result = q
    ? await listProducts({ q, page, pageSize: 24, sort })
    : { items: [], total: 0, page: 1, pageSize: 24, pageCount: 1 };

  // Spec §2.8 — page > totalPages → redirect to page 1.
  if (q && result.total > 0 && page > result.pageCount) {
    const sp = new URLSearchParams({ q, sort });
    redirect(`/search?${sp.toString()}`);
  }

  // Item 12 Phase 2 — SEO. Empty-query search renders a totally
  //   non-indexable shell, so always noindex it.
  const cfg = await getStoreConfig();
  const seo = q
    ? buildPaginationSeo({
        origin:       env.APP_URL.replace(/\/+$/, ''),
        basePath:     '/search',
        searchParams: { q, sort } as Record<string, string>,
        currentPage:  result.page,
        totalPages:   result.pageCount,
        config:       cfg,
      })
    : { canonical: `${env.APP_URL.replace(/\/+$/, '')}/search`, robotsNoindex: true };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <PaginationSeoLinks {...seo} />
      <h1 className="text-2xl font-bold text-slate-900">
        {q ? <>Search results for <em className="font-normal">“{q}”</em></> : 'Search'}
      </h1>
      <p className="text-sm text-slate-600">{result.total} result{result.total === 1 ? '' : 's'}</p>

      {!q && (
        <p className="mt-6 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          Type a query in the top search bar to find products.
        </p>
      )}

      {q && result.items.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="font-semibold">No products match “{q}”.</p>
          <p className="mt-1 text-sm text-slate-500">Try fewer words or a different brand.</p>
        </div>
      )}

      {result.items.length > 0 && (
        <>
          <div className="mt-6">
            <ProductGrid
              items={result.items.map<ProductCardData>((p) => ({
                id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc,
                mrpPaise: p.mrpPaise, pricePaise: p.pricePaise,
                imageUrl: p.images[0]?.url ?? null,
                brand: p.brand ? { name: p.brand.name } : null,
                category: p.category ? { name: p.category.name, slug: p.category.slug } : null,
                stock: p.stock,
                hasVariants: p.variants.length > 0,
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
              baseSearchParams={{ q, sort }}
            />
          </div>

          {/* Pagination (Item 12) */}
          <Pagination
            currentPage={result.page}
            totalPages={result.pageCount}
            pageSize={result.pageSize}
            totalItems={result.total}
            basePath="/search"
            searchParams={{ q, sort }}
            jumpInputThreshold={cfg.performance.paginationJumpInputThreshold}
            keyboardNav
          />
        </>
      )}
    </main>
  );
}
