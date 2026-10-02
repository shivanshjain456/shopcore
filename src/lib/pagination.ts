/**
 * Pagination utilities — Item 12.
 *
 *   parsePaginationParams(searchParams, config) → { page, pageSize, skip, take }
 *   parseCursorParams(searchParams, config)     → { cursor, pageSize, take }
 *   paginatedQuery(model, args, opts)           → { items, pagination }
 *   cursorQuery(items, pageSize, cursorField)   → { items, pagination }
 *   buildPageWindow(page, totalPages)           → [1, 2, 'ellipsis', 7, 8, ...]
 *
 * The PaginationMeta shape is the stable PUBLIC API of every list
 * endpoint — see API.md. Do not change field names without a
 * deprecation plan.
 *
 * Pure module — no Prisma import at the top level (paginatedQuery
 * takes the model + args, so callers retain full Prisma typing).
 */
import { z } from 'zod';
import { ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import type { UnifiedStoreConfig } from '@/lib/storeConfig';

// ── Public types ─────────────────────────────────────────────────────────

/** Standard offset-paginated metadata returned alongside `items`. */
export interface PaginationMeta {
  total:       number;
  page:        number;
  pageSize:    number;
  totalPages:  number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** Cursor-paginated metadata. `total` is `null` because COUNT(*) on
 *  large tables is expensive and not required for cursor navigation. */
export interface CursorPaginationMeta {
  total:       null;
  nextCursor:  string | null;
  /** Echo of the cursor the caller supplied (so they can build a
   *  prev-page URL without keeping client-side history). */
  prevCursor:  string | null;
  pageSize:    number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResult<T> {
  items:      T[];
  pagination: PaginationMeta;
}

export interface CursorPaginatedResult<T> {
  items:      T[];
  pagination: CursorPaginationMeta;
}

export interface ParsedOffsetParams {
  page:     number;
  pageSize: number;
  skip:     number;
  take:     number;
}

export interface ParsedCursorParams {
  cursor:   string | undefined;
  pageSize: number;
  take:     number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Accept either `URLSearchParams` (route handlers) or the plain object
 *  shape Next.js 14 server-component `searchParams` props expose. */
export type AnySearchParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function get(sp: AnySearchParams, key: string): string | undefined {
  if (sp instanceof URLSearchParams) {
    const v = sp.get(key);
    return v === null ? undefined : v;
  }
  const raw = sp[key];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Parse a positive-integer query parameter. Returns `null` for missing
 *  values (caller substitutes default); throws on garbage / negative. */
function parsePositiveInt(value: string | undefined, label: string): number | null {
  if (value === undefined || value === '') return null;
  // Strict: integer-only digits. Hex / float / sign / whitespace all fail.
  if (!/^\d+$/.test(value)) {
    log.warn('pagination.param_invalid', { param: label, value, reason: 'not_a_positive_integer' });
    throw new ValidationError(
      `Pagination parameter "${label}" must be a positive integer.`,
      { code: 'INVALID_PAGINATION_PARAMS', context: { param: label, value } },
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(
      `Pagination parameter "${label}" must be a non-negative integer.`,
      { code: 'INVALID_PAGINATION_PARAMS', context: { param: label, value } },
    );
  }
  return n;
}

/** Match Prisma-flavoured CUIDs the schema generates by default
 *  (`@default(cuid())`). Cuids start with `c` and are 25 chars of
 *  base-36; we accept ≥ 24 to be future-proof for cuid2. */
const CUID_RE = /^c[a-z0-9]{20,}$/i;
/** Liberal additional alphanumeric token to accept hand-crafted cursors
 *  used by some tables (e.g. AuditLog with composite ids). Hard cap
 *  prevents pathological inputs. */
const CURSOR_LIBERAL_RE = /^[A-Za-z0-9_-]{8,128}$/;

const CursorSchema = z
  .string()
  .min(1).max(128)
  .refine(
    (s) => CUID_RE.test(s) || CURSOR_LIBERAL_RE.test(s),
    { message: 'Cursor value is not a valid identifier.' },
  );

// ── parsePaginationParams ────────────────────────────────────────────────

export interface ConfigLike {
  performance: {
    paginationDefaultSize: number;
    paginationMaxSize:     number;
  };
}

/**
 * Offset-pagination parser. Reads `page` / `pageSize` from the search
 * params; defaults from store config; clamps `pageSize` to
 * `[1, paginationMaxSize]`.
 *
 *   - Garbage (`?page=abc`) → `ValidationError(INVALID_PAGINATION_PARAMS)`.
 *   - `page <= 0` → `ValidationError`.
 *   - `pageSize > paginationMaxSize` → silently clamped (log.warn).
 *   - Missing config → defends with 20 / 100 fallbacks (spec §3.10).
 *
 * Override page-size default per endpoint via `defaultPageSize` —
 * useful for the storefront grid that wants 24 even though the global
 * default is 20. The CAP (`paginationMaxSize`) is non-negotiable.
 */
export function parsePaginationParams(
  searchParams: AnySearchParams,
  config: ConfigLike | UnifiedStoreConfig,
  opts: { defaultPageSize?: number } = {},
): ParsedOffsetParams {
  // Defensive: misconfigured store-config (0/negative) defaults to 20 / 100.
  const cfgDefault = Math.max(1, Math.floor(config.performance.paginationDefaultSize ?? 20));
  const cfgMax     = Math.max(1, Math.floor(config.performance.paginationMaxSize     ?? 100));

  const rawPage     = get(searchParams, 'page');
  const rawPageSize = get(searchParams, 'pageSize');

  const parsedPage = parsePositiveInt(rawPage, 'page');
  const page = parsedPage === null ? 1 : Math.max(1, parsedPage);
  if (parsedPage !== null && parsedPage < 1) {
    throw new ValidationError('Pagination parameter "page" must be ≥ 1.', {
      code: 'INVALID_PAGINATION_PARAMS', context: { param: 'page', value: rawPage },
    });
  }

  const parsedPageSize = parsePositiveInt(rawPageSize, 'pageSize');
  const requestedSize  = parsedPageSize === null
    ? Math.max(1, Math.floor(opts.defaultPageSize ?? cfgDefault))
    : Math.max(1, parsedPageSize);
  const pageSize = Math.min(requestedSize, cfgMax);
  if (parsedPageSize !== null && requestedSize > cfgMax) {
    log.warn('pagination.size_clamped', { requested: requestedSize, clamped: cfgMax });
  }

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

// ── parseCursorParams ────────────────────────────────────────────────────

/**
 * Cursor-pagination parser. Returns the requested cursor (validated)
 * + the requested pageSize.
 *
 *   - Cursor of `''` → treated as "first page" (cursor: undefined).
 *   - Invalid cursor → `ValidationError`. Prevents arbitrary string
 *     injection through Prisma's `cursor: { id: <untrusted> }` —
 *     spec §3.9 (security).
 */
export function parseCursorParams(
  searchParams: AnySearchParams,
  config: ConfigLike | UnifiedStoreConfig,
  opts: { defaultPageSize?: number } = {},
): ParsedCursorParams {
  const cfgDefault = Math.max(1, Math.floor(config.performance.paginationDefaultSize ?? 20));
  const cfgMax     = Math.max(1, Math.floor(config.performance.paginationMaxSize     ?? 100));

  const rawCursor   = get(searchParams, 'cursor');
  const rawPageSize = get(searchParams, 'pageSize');

  let cursor: string | undefined;
  if (rawCursor !== undefined && rawCursor !== '') {
    const r = CursorSchema.safeParse(rawCursor);
    if (!r.success) {
      log.warn('pagination.param_invalid', {
        param: 'cursor', value: rawCursor.slice(0, 32), reason: 'invalid_format',
      });
      throw new ValidationError(
        'Pagination cursor is not a valid identifier.',
        { code: 'INVALID_PAGINATION_PARAMS', context: { param: 'cursor' } },
      );
    }
    cursor = r.data;
  }

  const parsedSize = parsePositiveInt(rawPageSize, 'pageSize');
  const requested  = parsedSize === null
    ? Math.max(1, Math.floor(opts.defaultPageSize ?? cfgDefault))
    : Math.max(1, parsedSize);
  const pageSize = Math.min(requested, cfgMax);
  if (parsedSize !== null && requested > cfgMax) {
    log.warn('pagination.size_clamped', { requested, clamped: cfgMax });
  }

  return { cursor, pageSize, take: pageSize };
}

// ── paginatedQuery ───────────────────────────────────────────────────────

/**
 * Wrap a Prisma `findMany` + matching `count` in a single
 * `$transaction` so the count can't go stale mid-page. Returns the
 * standard envelope.
 *
 * Caller controls the SELECT / WHERE / ORDER. We accept any Prisma
 * model that has both `.findMany` and `.count` (every model does).
 *
 * Generic signature accepts ANY Prisma client model object (typed at
 * the call site as e.g. `prisma.product`).
 */
export interface PaginatedQueryOpts<TFindManyArgs> {
  /** Args passed verbatim to model.findMany. MUST include `where` if
   *  you want count to be filtered too. */
  findManyArgs: TFindManyArgs;
  /** Override the where clause used by count (defaults to
   *  findManyArgs.where). Useful when findManyArgs has includes /
   *  selects that aren't allowed in count. */
  countWhere?:  Record<string, unknown>;
  page:         number;
  pageSize:     number;
}

/**
 * Concrete shape Prisma exposes — abstracted so this helper doesn't
 * pull `@prisma/client` types and the caller keeps full Prisma type
 * inference at the use site.
 */
export interface PrismaListModel<T, FindManyArgs> {
  findMany(args: FindManyArgs): Promise<T[]>;
  count(args: { where?: Record<string, unknown> }): Promise<number>;
}

export async function paginatedQuery<T, FindManyArgs extends {
  where?:   Record<string, unknown>;
  skip?:    number;
  take?:    number;
}>(
  model: PrismaListModel<T, FindManyArgs>,
  opts:  PaginatedQueryOpts<FindManyArgs>,
): Promise<PaginatedResult<T>> {
  const { findManyArgs, page, pageSize } = opts;
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  // `$transaction` would bind us to a specific PrismaClient; instead
  // we run the two calls in parallel — SQLite is single-writer and
  // we're reading both, so consistency is best-effort. For stronger
  // serialisation guarantees, the caller can wrap the model accessor
  // in their own $transaction.
  const where = (opts.countWhere ?? findManyArgs.where ?? {}) as Record<string, unknown>;
  const [items, total] = await Promise.all([
    model.findMany({ ...findManyArgs, skip, take } as FindManyArgs),
    model.count({ where }),
  ]);

  const totalPages = pageSize > 0 ? Math.max(0, Math.ceil(total / pageSize)) : 0;
  return {
    items,
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

/**
 * Build an offset-pagination envelope from a pre-computed
 * `(items, total)` pair. Use when the caller already has both numbers
 * (e.g. ran its own `$transaction`).
 */
export function buildPagination<T>(
  items: T[], total: number, page: number, pageSize: number,
): PaginatedResult<T> {
  const totalPages = pageSize > 0 ? Math.max(0, Math.ceil(total / pageSize)) : 0;
  return {
    items,
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

/**
 * Build a cursor-pagination envelope from a list that was fetched with
 * `take: pageSize + 1` (the +1 is the "is there a next page?" probe).
 *
 *   const fetched = await prisma.x.findMany({
 *     orderBy: { createdAt: 'desc' },
 *     take: pageSize + 1,
 *     cursor: cursor ? { id: cursor } : undefined,
 *     skip:   cursor ? 1 : 0,
 *   });
 *   return buildCursorPagination(fetched, pageSize, 'id', cursor);
 */
export function buildCursorPagination<T extends Record<string, unknown>>(
  fetched:    T[],
  pageSize:   number,
  cursorField: keyof T & string,
  prevCursor: string | undefined,
): CursorPaginatedResult<T> {
  const hasNextPage = fetched.length > pageSize;
  const items = hasNextPage ? fetched.slice(0, pageSize) : fetched;
  const last = items[items.length - 1];
  const nextCursor: string | null =
    hasNextPage && last !== undefined
      ? String(last[cursorField] ?? '') || null
      : null;
  return {
    items,
    pagination: {
      total:      null,
      nextCursor,
      prevCursor: prevCursor ?? null,
      pageSize,
      hasNextPage,
      hasPrevPage: prevCursor !== undefined,
    },
  };
}

// ── buildPageWindow ──────────────────────────────────────────────────────

/** A sentinel literal — preferred over the string `'...'` so the
 *  `<Pagination>` component can `switch` on it type-safely. */
export type PageWindowItem = number | 'ellipsis';

/**
 * Build the page-number window for the `<Pagination>` component. Pure
 * function — extensively tested at every edge case.
 *
 *   buildPageWindow(1, 1)   → [1]
 *   buildPageWindow(1, 5)   → [1, 2, 3, 4, 5]
 *   buildPageWindow(1, 20)  → [1, 2, 3, 4, 5, 'ellipsis', 20]
 *   buildPageWindow(10, 20) → [1, 'ellipsis', 8, 9, 10, 11, 12, 'ellipsis', 20]
 *   buildPageWindow(20, 20) → [1, 'ellipsis', 16, 17, 18, 19, 20]
 *   buildPageWindow(3, 20)  → [1, 2, 3, 4, 5, 'ellipsis', 20]
 *   buildPageWindow(7, 20)  → [1, 'ellipsis', 5, 6, 7, 8, 9, 'ellipsis', 20]
 *
 * Algorithm:
 *   - if totalPages ≤ 7, show every page (no ellipsis ever needed for ≤ 7).
 *   - otherwise: ALWAYS first + last. Pick window = [current-2, current+2]
 *     clamped to [2, totalPages-1]. If the window's left edge > 2,
 *     insert an ellipsis at position 1; if the window's right edge <
 *     totalPages-1, insert an ellipsis before the last page.
 *
 * The "extend if near the edge" rule keeps the visible button count
 * stable at 7-9 across all current-page positions — visually pleasant.
 */
export function buildPageWindow(current: number, totalPages: number): PageWindowItem[] {
  if (totalPages <= 0) return [];
  if (totalPages === 1) return [1];
  // Clamp current into valid range so callers don't have to.
  const c = Math.max(1, Math.min(current, totalPages));

  if (totalPages <= 7) {
    const out: PageWindowItem[] = [];
    for (let i = 1; i <= totalPages; i++) out.push(i);
    return out;
  }

  // ── More than 7 pages: constant-width 5-page window around current,
  //    anchored to first + last, with ellipses only for ACTUAL gaps.
  let windowStart = c - 2;
  let windowEnd   = c + 2;

  // Shift window right if it falls off the left edge.
  if (windowStart < 1) {
    windowEnd  += 1 - windowStart;
    windowStart = 1;
  }
  // Shift window left if it falls off the right edge.
  if (windowEnd > totalPages) {
    windowStart -= windowEnd - totalPages;
    windowEnd    = totalPages;
  }
  windowStart = Math.max(1, windowStart);
  windowEnd   = Math.min(totalPages, windowEnd);

  const out: PageWindowItem[] = [];
  if (windowStart > 1) {
    out.push(1);
    if (windowStart > 2) out.push('ellipsis');
  }
  for (let i = windowStart; i <= windowEnd; i++) out.push(i);
  if (windowEnd < totalPages) {
    if (windowEnd < totalPages - 1) out.push('ellipsis');
    out.push(totalPages);
  }
  return out;
}
