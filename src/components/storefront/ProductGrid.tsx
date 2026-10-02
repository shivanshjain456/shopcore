'use client';
/**
 * <ProductGrid> — Item 12 Phase 2.
 *
 * Server-rendered storefront category / search pages compose their
 * grid in JSX. This thin client wrapper picks between two render
 * paths at runtime:
 *
 *   - InfiniteScroll on (admin opted in via
 *     `performance.paginationInfiniteScrollEnabled`):
 *     mount the IntersectionObserver-backed `<InfiniteScroll>`.
 *   - off (default): render a plain grid that matches the prior
 *     server-side output — no JS-runtime fetch path.
 *
 * The host page ALWAYS renders the standard `<Pagination>` bar below
 * the grid. When infinite scroll is on, the bar still works for users
 * who hit Tab/Enter on a numbered button (they jump to that page —
 * the `<Pagination>` is in LINK mode, so it's a full navigation).
 */
import type { ReactNode } from 'react';
import ProductCard, { type ProductCardData } from './ProductCard';
import InfiniteScroll from '@/components/InfiniteScroll';
import type { PaginationMeta } from '@/lib/pagination';

export interface ProductGridProps {
  items:           ProductCardData[];
  pagination:      PaginationMeta;
  /** When true, mount InfiniteScroll. */
  infiniteScroll:  boolean;
  /** Required when `infiniteScroll` is true. */
  pageEndpoint?:   string;
  /** Filters/sort to forward on every subsequent fetch. */
  baseSearchParams?: Record<string, string | undefined>;
}

const GRID_CLASSES = 'grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

function renderCard(p: ProductCardData): ReactNode {
  return <ProductCard p={p} />;
}

export default function ProductGrid(props: ProductGridProps): JSX.Element {
  const { items, pagination, infiniteScroll, pageEndpoint, baseSearchParams } = props;

  if (!infiniteScroll || !pageEndpoint) {
    return (
      <div className={GRID_CLASSES}>
        {items.map((p) => (
          <ProductCard key={p.id} p={p} />
        ))}
      </div>
    );
  }

  return (
    <InfiniteScroll<ProductCardData>
      pageEndpoint={pageEndpoint}
      initialItems={items}
      pagination={pagination}
      baseSearchParams={baseSearchParams}
      renderItem={renderCard}
      getKey={(p) => p.id}
      gridClassName={GRID_CLASSES}
      itemLabel="products"
    />
  );
}
