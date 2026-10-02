'use client';
/**
 * <InfiniteScroll> — Item 12 Phase 2.
 *
 * Progressive-enhancement infinite scroll for storefront lists.
 *
 *   <InfiniteScroll
 *     pageEndpoint="/api/products"
 *     initialItems={items}
 *     pagination={pagination}
 *     baseSearchParams={spRecord}
 *     renderItem={(p) => <ProductCard p={p} />}
 *     gridClassName="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
 *   />
 *
 * Behaviour:
 *   - Renders `initialItems` immediately (SSR / RSC payload — no
 *     waterfall).
 *   - When the user scrolls within ~200 px of the sentinel, fetches
 *     `pageEndpoint?page=<next>&pageSize=<current>&…baseSearchParams`
 *     and appends `data.items`.
 *   - Idempotent: page numbers are tracked in a Set so the same page
 *     can never be fetched twice (e.g. when the IntersectionObserver
 *     fires multiple times during a scroll).
 *   - `prefers-reduced-motion: reduce` → swap the IntersectionObserver
 *     out for an explicit "Load more" <button>. Same accessibility
 *     payoff (motion / animation is irrelevant here; the spec point
 *     is that involuntary content shifts hurt users with vestibular
 *     conditions and screen-reader users alike).
 *   - When all pages are loaded, the sentinel hides and an aria-live
 *     announcement says "All <total> items shown.".
 *   - <noscript> fallback is the standard <Pagination> numbered bar
 *     the host page also renders below this — InfiniteScroll is an
 *     ENHANCEMENT, not a replacement. Search engines + JS-off users
 *     still get crawlable / navigable pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PaginationMeta } from '@/lib/pagination';

export interface InfiniteScrollProps<T> {
  /** API endpoint that returns the standard envelope. */
  pageEndpoint:    string;
  /** Items already on the page from SSR. */
  initialItems:    T[];
  /** Pagination meta for the first SSR page. */
  pagination:      PaginationMeta;
  /** Extra query-string parameters to forward on every request (filters
   *  / sort). `page` and `pageSize` are managed by this component. */
  baseSearchParams?: Record<string, string | undefined>;
  /** Render a single item. The key is supplied by getKey(). */
  renderItem:      (item: T, index: number) => ReactNode;
  /** Stable key extractor. Required — fallback to index keys would
   *  break React reconciliation across appended pages. */
  getKey:          (item: T, index: number) => string | number;
  /** Wrapper element classes (so the host page controls grid layout). */
  gridClassName?:  string;
  /** Optional label for screen readers — default "items". */
  itemLabel?:      string;
  /** When true, force the "Load more" button instead of the
   *  IntersectionObserver. Useful for tests and for users with
   *  `prefers-reduced-motion`. Defaults to auto-detect. */
  forceLoadMoreButton?: boolean;
}

interface ApiEnvelope<T> {
  ok?: boolean;
  data?: { items: T[]; pagination: PaginationMeta };
}

function buildUrl(endpoint: string, base: Record<string, string | undefined> | undefined, page: number, pageSize: number): string {
  const sp = new URLSearchParams();
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      if (v !== undefined && v !== '') sp.set(k, v);
    }
  }
  sp.set('page',     String(page));
  sp.set('pageSize', String(pageSize));
  return `${endpoint}?${sp.toString()}`;
}

export default function InfiniteScroll<T>(props: InfiniteScrollProps<T>): JSX.Element {
  const {
    pageEndpoint, initialItems, pagination, baseSearchParams,
    renderItem, getKey, gridClassName, itemLabel = 'items',
    forceLoadMoreButton,
  } = props;

  const [items,        setItems]        = useState<T[]>(initialItems);
  const [currentPage,  setCurrentPage]  = useState<number>(pagination.page);
  const [totalPages,   setTotalPages]   = useState<number>(pagination.totalPages);
  const [totalItems,   setTotalItems]   = useState<number>(pagination.total);
  const [loading,      setLoading]      = useState<boolean>(false);
  const [error,        setError]        = useState<string | null>(null);
  const loadedPagesRef = useRef<Set<number>>(new Set([pagination.page]));
  const sentinelRef    = useRef<HTMLDivElement | null>(null);

  // Detect prefers-reduced-motion (post-mount only — SSR-safe).
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const useButton = forceLoadMoreButton ?? reducedMotion;

  const hasMore = currentPage < totalPages;

  const loadPage = useCallback(async (page: number): Promise<void> => {
    if (loadedPagesRef.current.has(page)) return;
    loadedPagesRef.current.add(page);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        buildUrl(pageEndpoint, baseSearchParams, page, pagination.pageSize),
        { credentials: 'same-origin' },
      );
      const body = (await res.json()) as ApiEnvelope<T>;
      if (!res.ok || !body.ok || !body.data) {
        // Allow a retry on the next intersection — remove from cache.
        loadedPagesRef.current.delete(page);
        setError('Could not load more. Tap "Load more" to retry.');
        return;
      }
      setItems((prev) => [...prev, ...body.data!.items]);
      setCurrentPage(body.data.pagination.page);
      setTotalPages(body.data.pagination.totalPages);
      setTotalItems(body.data.pagination.total);
    } catch {
      loadedPagesRef.current.delete(page);
      setError('Network error. Tap "Load more" to retry.');
    } finally {
      setLoading(false);
    }
  }, [pageEndpoint, baseSearchParams, pagination.pageSize]);

  // IntersectionObserver — kicks in once the sentinel is near the
  // viewport. Suspends itself once there's no more data, and when the
  // button-mode is on.
  useEffect(() => {
    if (useButton) return;
    if (!hasMore || loading) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void loadPage(currentPage + 1);
        }
      },
      { rootMargin: '0px 0px 200px 0px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [useButton, hasMore, loading, currentPage, loadPage]);

  const liveText = useMemo(() => {
    if (!hasMore && totalItems > 0) return `All ${totalItems} ${itemLabel} shown.`;
    if (items.length > 0) return `Showing ${items.length} of ${totalItems} ${itemLabel}.`;
    return '';
  }, [hasMore, items.length, totalItems, itemLabel]);

  return (
    <>
      <div className={gridClassName} data-testid="infinite-scroll-grid">
        {items.map((it, i) => (
          <div key={getKey(it, i)}>{renderItem(it, i)}</div>
        ))}
      </div>

      {/* Live region for screen readers; visually hidden. */}
      <p
        aria-live="polite"
        className="sr-only absolute -m-px h-px w-px overflow-hidden border-0 p-0"
      >
        {liveText}
      </p>

      {hasMore && (useButton ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => { void loadPage(currentPage + 1); }}
            disabled={loading}
            className="tap-target rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : (
        <div ref={sentinelRef} aria-hidden="true" className="mt-6 h-px w-full" />
      ))}

      {loading && !useButton && (
        <p className="mt-3 text-center text-xs text-slate-500" role="status">
          Loading more {itemLabel}…
        </p>
      )}

      {error && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <p className="text-sm text-red-700" role="alert">{error}</p>
          <button
            type="button"
            onClick={() => { void loadPage(currentPage + 1); }}
            className="tap-target rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Load more
          </button>
        </div>
      )}
    </>
  );
}
