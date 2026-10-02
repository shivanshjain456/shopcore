/**
 * Pagination SEO helpers — Item 12 Phase 2.
 *
 *   buildPaginationSeo({ basePath, searchParams, currentPage, totalPages, env })
 *     → { canonical, prevUrl?, nextUrl?, robotsNoindex }
 *
 *   <PaginationSeoLinks {...result} /> — server component that emits
 *     <link rel="canonical"> + <link rel="prev/next"> for hoisting into
 *     <head> (React-built-in tag-hoisting that Next.js preserves).
 *
 * SEO contract:
 *   - `canonical` is the URL of the CURRENT page (Google's preferred
 *     post-2019 behaviour — they no longer recommend canonicalising
 *     all paged URLs to page 1).
 *   - `<link rel="prev">` / `<link rel="next">` are still useful as a
 *     navigation hint for Bing / Yandex / older Googlebot.
 *   - `robotsNoindex` is true once `currentPage >= cfg.performance
 *     .paginationNoindexFromPage` — the spec's "thin-content" guard
 *     against indexing deep filter combinations.
 *
 * Pure module — no Prisma / Next imports at the value level.
 */
import type { UnifiedStoreConfig } from '@/lib/storeConfig';

export interface BuildPaginationSeoArgs {
  /** Absolute origin (e.g. `https://shop.example.com`). MUST NOT end with `/`. */
  origin:        string;
  /** Path part WITHOUT the query string (e.g. `/c/laptops`). MUST start with `/`. */
  basePath:      string;
  /** All current query params (passed through verbatim — `page` is replaced). */
  searchParams:  Record<string, string | string[] | undefined>;
  currentPage:   number;
  totalPages:    number;
  config:        UnifiedStoreConfig;
}

export interface PaginationSeoResult {
  /** Canonical URL of the CURRENT page (always present). */
  canonical:    string;
  /** Absolute URL of the previous page (omitted on page 1). */
  prevUrl?:     string;
  /** Absolute URL of the next page (omitted on the last page). */
  nextUrl?:     string;
  /** When true, the page should render `<meta name="robots"
   *  content="noindex,follow">`. */
  robotsNoindex: boolean;
}

function flattenSearchParams(
  sp: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v[0] !== undefined) out.set(k, v[0]);
    } else {
      out.set(k, v);
    }
  }
  return out;
}

function buildUrl(origin: string, basePath: string, params: URLSearchParams, page: number | null): string {
  const copy = new URLSearchParams(params);
  if (page === null || page === 1) copy.delete('page');
  else copy.set('page', String(page));
  const qs = copy.toString();
  return `${origin}${basePath}${qs ? `?${qs}` : ''}`;
}

export function buildPaginationSeo(args: BuildPaginationSeoArgs): PaginationSeoResult {
  const { origin, basePath, searchParams, currentPage, totalPages, config } = args;
  const flat = flattenSearchParams(searchParams);
  // `page` is rebuilt below; strip it from the carry-over set so we
  // don't double-encode.
  flat.delete('page');

  const safeCurrent = Math.max(1, Math.min(currentPage, Math.max(1, totalPages)));
  const canonical = buildUrl(origin, basePath, flat, safeCurrent);
  const result: PaginationSeoResult = {
    canonical,
    robotsNoindex: false,
  };
  if (safeCurrent > 1) {
    result.prevUrl = buildUrl(origin, basePath, flat, safeCurrent - 1);
  }
  if (safeCurrent < totalPages) {
    result.nextUrl = buildUrl(origin, basePath, flat, safeCurrent + 1);
  }
  const noindexFrom = Math.max(
    1,
    Math.floor(config.performance.paginationNoindexFromPage ?? 2),
  );
  if (safeCurrent >= noindexFrom && totalPages > 1) {
    result.robotsNoindex = true;
  }
  return result;
}
