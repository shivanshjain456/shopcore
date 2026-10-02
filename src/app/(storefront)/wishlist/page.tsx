import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import ProductCard from '@/components/storefront/ProductCard';
import Pagination from '@/components/Pagination';
import PaginationSeoLinks from '@/components/seo/PaginationSeoLinks';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { buildPaginationSeo } from '@/lib/seo/paginationSeo';
import { getStoreConfig } from '@/lib/storeConfig';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export default async function WishlistPage({ searchParams }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/wishlist');

  // Item 12 — wishlists can grow long; paginate at the page level
  //   (the /api/wishlist endpoint keeps its set-membership { ids }
  //   shape; this UI uses Prisma directly because it joins product
  //   data for the grid).
  const cfg = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(searchParams, cfg, { defaultPageSize: 24 });

  const [total, rows] = await Promise.all([
    prisma.wishlistItem.count({ where: { userId: user.id } }),
    prisma.wishlistItem.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      skip, take,
      include: {
        product: {
          include: {
            images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
            brand:  { select: { name: true } },
            category: { select: { name: true, slug: true } },
          },
        },
      },
    }),
  ]);
  const { pagination } = buildPagination(rows, total, page, pageSize);
  // Spec §2.8 — page > totalPages → redirect to page 1.
  if (total > 0 && page > pagination.totalPages) {
    redirect('/wishlist');
  }
  const items = rows;

  // Item 12 Phase 2 — wishlist pages are inherently per-user; always
  //   noindex regardless of `paginationNoindexFromPage`.
  const seo = buildPaginationSeo({
    origin:       env.APP_URL.replace(/\/+$/, ''),
    basePath:     '/wishlist',
    searchParams,
    currentPage:  pagination.page,
    totalPages:   pagination.totalPages,
    config:       cfg,
  });
  seo.robotsNoindex = true;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <PaginationSeoLinks {...seo} />
      <h1 className="text-2xl font-bold text-slate-900">Your wishlist</h1>
      <p className="text-sm text-slate-600">{total} saved product{total === 1 ? '' : 's'}</p>

      {items.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="font-semibold">No items yet.</p>
          <p className="mt-1 text-sm text-slate-500">Tap the ♥ on any product to save it for later.</p>
          <Link href="/" className="mt-4 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Browse products
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((w) => (
            <ProductCard key={w.id} p={{
              id: w.product.id, slug: w.product.slug, name: w.product.name, shortDesc: w.product.shortDesc,
              mrpPaise: w.product.mrpPaise, pricePaise: w.product.pricePaise,
              imageUrl: w.product.images[0]?.url ?? null,
              brand: w.product.brand,
              category: w.product.category,
              stock: w.product.stock,
            }} />
          ))}
        </div>
      )}
      <Pagination
        currentPage={pagination.page}
        totalPages={pagination.totalPages}
        pageSize={pagination.pageSize}
        totalItems={pagination.total}
        basePath="/wishlist"
        searchParams={searchParams}
        jumpInputThreshold={cfg.performance.paginationJumpInputThreshold}
        keyboardNav
      />
    </main>
  );
}
