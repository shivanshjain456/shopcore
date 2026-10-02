'use client';
/**
 * <Pagination> — Item 12. The single canonical pagination control for
 * the whole app.
 *
 * Two operating modes (use ONE per call site):
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ LINK MODE   (storefront server-rendered pages)                  │
 *   │   pass `basePath` + `searchParams`. Renders <Link> elements so  │
 *   │   each page is a separate navigable URL — crawlable by search   │
 *   │   engines and friendly to browser back/forward.                 │
 *   └──────────────────────────────────────────────────────────────────┘
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ CALLBACK MODE   (admin client-rendered pages)                   │
 *   │   pass `onPageChange`. Renders <button> elements. Pass          │
 *   │   `urlSync` to ALSO mirror page / pageSize into the URL so the  │
 *   │   browser back button + bookmarks work (Phase 2).               │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Renders NOTHING when totalPages <= 1 (spec §2.8) — caller doesn't
 * need to guard.
 *
 * Mobile (< sm): Prev / "Page N of M" / Next. Numeric buttons hidden.
 * Tablet+ (sm+): full page window via buildPageWindow.
 *
 * Phase 2 features (off by default — opt-in via props):
 *   - `jumpInputThreshold`  shows a "Go to page …" numeric input once
 *                           `totalPages >= threshold`.
 *   - `keyboardNav`         ArrowLeft / ArrowRight on the <nav> jump
 *                           to prev / next page.
 *   - `urlSync` (callback mode)
 *                           every page-/size-change is also pushed
 *                           into the URL via router.push().
 *
 * a11y: <nav aria-label="Pagination">, aria-current="page" on the
 * active page, descriptive aria-labels on every link/button,
 * aria-hidden on ellipsis spans, keyboard nav announced via
 * aria-keyshortcuts="ArrowLeft ArrowRight".
 */
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { buildPageWindow } from '@/lib/pagination';
import PageSizeSelector from './PageSizeSelector';

export interface PaginationProps {
  currentPage:  number;
  totalPages:   number;
  pageSize:     number;
  /** Optional total — when present, renders "Showing 21-40 of 247". */
  totalItems?:  number | null;
  /** LINK mode — base path (no query string). The component preserves
   *  every existing query param and only overrides `page`. */
  basePath?:    string;
  /** LINK mode — current search params (from `useSearchParams()` or
   *  the page's `searchParams` prop). */
  searchParams?: URLSearchParams | Record<string, string | string[] | undefined>;
  /** CALLBACK mode — invoked with the new page. */
  onPageChange?: (page: number) => void;
  /** When true, render the page-size dropdown. Default false. */
  showPageSizeSelector?: boolean;
  /** Override the default selector options [10, 20, 50, 100]. */
  availablePageSizes?:   readonly number[];
  /** Hard cap on page-size selector options (mirrors
   *  performance.paginationMaxSize when relevant). */
  maxPageSize?:         number;
  onPageSizeChange?:    (size: number) => void;
  className?:           string;

  // ── Phase 2 ──────────────────────────────────────────────────────
  /** Show the "Go to page …" numeric input once `totalPages >=
   *  threshold`. Pass `Infinity` (or omit) to hide it always. */
  jumpInputThreshold?:  number;
  /** Enable ArrowLeft / ArrowRight keyboard navigation when the
   *  pagination control has focus. Default false. */
  keyboardNav?:         boolean;
  /** CALLBACK mode only — when true, every page / size change is also
   *  written to the URL via router.push(...). Lets the browser back
   *  button and bookmarks Just Work. The page reads its current page
   *  from the URL via useSearchParams() on the parent. */
  urlSync?:             boolean;
}

function toRecord(sp?: PaginationProps['searchParams']): Record<string, string> {
  if (!sp) return {};
  if (sp instanceof URLSearchParams) {
    const out: Record<string, string> = {};
    sp.forEach((v, k) => { out[k] = v; });
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v[0] !== undefined) out[k] = v[0];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildHref(basePath: string, sp: PaginationProps['searchParams'], page: number): string {
  const params = new URLSearchParams(toRecord(sp));
  params.set('page', String(page));
  return `${basePath}?${params.toString()}`;
}

/** Render a single page button (link or button depending on mode). */
function PageItem({
  page, currentPage, basePath, sp, onPageChange, label,
}: {
  page:        number;
  currentPage: number;
  basePath?:   string;
  sp?:         PaginationProps['searchParams'];
  onPageChange?: (p: number) => void;
  /** Override the displayed text — e.g. "‹" for prev arrow. */
  label?:      ReactNode;
}): JSX.Element {
  const isCurrent = page === currentPage;
  const text = label ?? page;
  const ariaLabel = label
    ? (typeof label === 'string' ? label : `Go to page ${page}`)
    : `Go to page ${page}`;
  const cls = isCurrent
    ? 'tap-target rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white'
    : 'tap-target rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50';

  if (basePath !== undefined) {
    // Link mode — Next.js <Link>. The href changes the URL; the
    // server re-renders with the new page.
    return (
      <Link
        href={buildHref(basePath, sp, page)}
        aria-label={ariaLabel}
        aria-current={isCurrent ? 'page' : undefined}
        className={cls}
        scroll={true}
      >
        {text}
      </Link>
    );
  }
  // Callback mode.
  return (
    <button
      type="button"
      onClick={() => onPageChange?.(page)}
      aria-label={ariaLabel}
      aria-current={isCurrent ? 'page' : undefined}
      className={cls}
    >
      {text}
    </button>
  );
}

function DisabledArrow({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }): JSX.Element {
  return (
    <span
      role="link"
      aria-disabled="true"
      aria-label={ariaLabel}
      className="tap-target rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-400"
    >
      {children}
    </span>
  );
}

/** "Go to page [   ] Go" — Phase 2 jump input. Pure UI; calls the
 *  same `goTo()` the arrows use, so urlSync (callback) and Link mode
 *  Just Work. */
function JumpToPageInput({
  totalPages, currentPage, goTo,
}: {
  totalPages:  number;
  currentPage: number;
  goTo:        (page: number) => void;
}): JSX.Element {
  const inputId = useId();
  const [value, setValue] = useState<string>('');
  function submit() {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(totalPages, n));
    if (clamped === currentPage) return;
    goTo(clamped);
    setValue('');
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="inline-flex items-center gap-2"
    >
      <label htmlFor={inputId} className="text-xs text-slate-600">
        Go to page:
      </label>
      <input
        id={inputId}
        type="number"
        min={1}
        max={totalPages}
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Jump to page (1 to ${totalPages})`}
        className="tap-target w-16 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
      />
      <button
        type="submit"
        className="tap-target rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        Go
      </button>
    </form>
  );
}

export default function Pagination(props: PaginationProps): JSX.Element | null {
  const {
    currentPage, totalPages, pageSize, totalItems,
    basePath, searchParams,
    onPageChange,
    showPageSizeSelector,
    availablePageSizes,
    maxPageSize,
    onPageSizeChange,
    className,
    jumpInputThreshold,
    keyboardNav,
    urlSync,
  } = props;

  // Hooks must run unconditionally — even if we early-return below
  // when totalPages <= 1, React requires the same hook sequence
  // every render. (Next.js bundles useRouter etc., so calling them
  // when not in a Next page context is safe — they return no-ops.)
  const router       = useRouter();
  const pathname     = usePathname();
  const liveParams   = useSearchParams();
  const navRef       = useRef<HTMLElement | null>(null);
  // Track whether we've mounted — we only attach keyboard listeners
  // client-side (this component is already 'use client', but
  // ref-based focus management is post-paint).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // ── URL sync (callback mode) — push ?page=N onto the URL when the
  //    parent calls our onPageChange wrapper. Filter / sort params are
  //    preserved verbatim. We do NOT push when in LINK mode (the
  //    <Link> handles it) or when urlSync is off.
  const pushUrl = useCallback(
    (next: { page?: number; pageSize?: number }) => {
      if (!urlSync) return;
      if (!pathname || !liveParams) return;
      const sp = new URLSearchParams(liveParams.toString());
      if (next.page !== undefined) {
        if (next.page === 1) sp.delete('page'); else sp.set('page', String(next.page));
      }
      if (next.pageSize !== undefined) {
        sp.set('pageSize', String(next.pageSize));
        // Resizing always resets to page 1 — spec §2.6.
        sp.delete('page');
      }
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [urlSync, pathname, liveParams, router],
  );

  // Spec §2.8 — caller doesn't have to guard.
  if (totalPages <= 1 && !showPageSizeSelector) return null;
  if (totalPages <= 0) return null;

  const safePage = Math.max(1, Math.min(currentPage, totalPages));
  const items    = buildPageWindow(safePage, totalPages);

  const hasPrev = safePage > 1;
  const hasNext = safePage < totalPages;

  // Single goTo() used by arrows, page numbers, jump input.
  const goTo = (p: number): void => {
    if (p === safePage) return;
    if (p < 1 || p > totalPages) return;
    onPageChange?.(p);
    pushUrl({ page: p });
  };
  const changeSize = (s: number): void => {
    onPageSizeChange?.(s);
    pushUrl({ pageSize: s });
  };

  // Keyboard nav — ArrowLeft / ArrowRight on the <nav>.
  function handleKeyDown(e: KeyboardEvent<HTMLElement>): void {
    if (!keyboardNav) return;
    // Ignore if focus is in an interactive sub-element (input, button)
    // — Tab handles those.
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.isContentEditable) return;
    if (e.key === 'ArrowLeft' && hasPrev) {
      e.preventDefault();
      goTo(safePage - 1);
    } else if (e.key === 'ArrowRight' && hasNext) {
      e.preventDefault();
      goTo(safePage + 1);
    }
  }

  // "Showing N-M of T" — only when totalItems is available.
  let summary: ReactNode = null;
  if (typeof totalItems === 'number' && totalItems > 0) {
    const from = (safePage - 1) * pageSize + 1;
    const to   = Math.min(from + pageSize - 1, totalItems);
    summary = (
      <p className="text-xs text-slate-600" aria-live="polite">
        Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{totalItems}</strong>
      </p>
    );
  }

  // Don't render numeric buttons when there's only one page (selector
  // may still need to show).
  const showNumeric    = totalPages > 1;
  const showJumpInput  = jumpInputThreshold !== undefined
                         && Number.isFinite(jumpInputThreshold)
                         && totalPages >= jumpInputThreshold
                         && showNumeric;

  // Build the page-link callback for nested <PageItem>s. In callback
  // mode + urlSync we want every numeric click to ALSO push the URL —
  // wrap onPageChange.
  const itemOnPageChange = basePath !== undefined
    ? undefined  // Link mode handles its own href
    : (p: number) => goTo(p);

  return (
    <nav
      ref={navRef}
      aria-label="Pagination"
      aria-keyshortcuts={keyboardNav ? 'ArrowLeft ArrowRight' : undefined}
      tabIndex={keyboardNav && mounted ? 0 : undefined}
      onKeyDown={keyboardNav ? handleKeyDown : undefined}
      className={`mt-4 flex flex-wrap items-center justify-between gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2">
        {summary}
      </div>

      {showNumeric && (
        <>
          {/* Mobile (< sm) — Prev / "Page N of M" / Next */}
          <div className="flex items-center gap-2 sm:hidden">
            {hasPrev ? (
              <PageItem page={safePage - 1} currentPage={safePage}
                basePath={basePath} sp={searchParams} onPageChange={itemOnPageChange}
                label="‹ Prev" />
            ) : (
              <DisabledArrow ariaLabel="Previous page (disabled)">‹ Prev</DisabledArrow>
            )}
            <span className="text-xs text-slate-700" aria-live="polite">
              Page <strong>{safePage}</strong> of <strong>{totalPages}</strong>
            </span>
            {hasNext ? (
              <PageItem page={safePage + 1} currentPage={safePage}
                basePath={basePath} sp={searchParams} onPageChange={itemOnPageChange}
                label="Next ›" />
            ) : (
              <DisabledArrow ariaLabel="Next page (disabled)">Next ›</DisabledArrow>
            )}
          </div>

          {/* Tablet+ — full window */}
          <div className="hidden items-center gap-1 sm:flex">
            {hasPrev ? (
              <PageItem page={safePage - 1} currentPage={safePage}
                basePath={basePath} sp={searchParams} onPageChange={itemOnPageChange}
                label="‹ Previous" />
            ) : (
              <DisabledArrow ariaLabel="Previous page (disabled)">‹ Previous</DisabledArrow>
            )}
            {items.map((it, idx) => {
              if (it === 'ellipsis') {
                return (
                  <span
                    key={`e${idx}`}
                    aria-hidden="true"
                    className="px-2 text-sm text-slate-400"
                  >
                    …
                  </span>
                );
              }
              return (
                <PageItem
                  key={it}
                  page={it}
                  currentPage={safePage}
                  basePath={basePath} sp={searchParams} onPageChange={itemOnPageChange}
                />
              );
            })}
            {hasNext ? (
              <PageItem page={safePage + 1} currentPage={safePage}
                basePath={basePath} sp={searchParams} onPageChange={itemOnPageChange}
                label="Next ›" />
            ) : (
              <DisabledArrow ariaLabel="Next page (disabled)">Next ›</DisabledArrow>
            )}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {showJumpInput && (
          <JumpToPageInput
            totalPages={totalPages}
            currentPage={safePage}
            goTo={goTo}
          />
        )}
        {showPageSizeSelector && onPageSizeChange && (
          <PageSizeSelector
            value={pageSize}
            options={availablePageSizes}
            maxPageSize={maxPageSize}
            onChange={changeSize}
          />
        )}
      </div>
    </nav>
  );
}
