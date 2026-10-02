'use client';
/**
 * InteractiveProductGallery — Item 20.
 *
 *   Client island that layers interaction on top of the Item-19
 *   `<ProductGallery>` foundation:
 *
 *     - Click / Enter / Space on a thumbnail swaps the main image.
 *     - Previous / Next buttons + keyboard ArrowLeft / ArrowRight on
 *       the gallery region cycle images; Home / End jump to ends.
 *     - Touch swipe (>40 px horizontal, <30 px vertical) cycles images.
 *     - Optional loop wrap-around (Amazon-style stop-at-end by default;
 *       Flipkart-style loop when `loopEnabled`).
 *     - Optional hover-zoom (desktop) / tap-zoom (mobile) — pure CSS
 *       `transform: scale(2)` follows the pointer position. Disabled
 *       under `prefers-reduced-motion` AND when `zoomEnabled=false`.
 *     - Optional fullscreen lightbox via the native `<dialog>` element
 *       (`showModal()` gives focus-trap + Escape-to-close + top-layer
 *       rendering for free). Lightbox shares the same state hook so
 *       the active image stays in sync when the customer closes it.
 *     - Transition fade between images (CSS opacity, capped at the
 *       admin's `transitionMs` setting; ZERO under reduced-motion).
 *     - Counter ("3 / 8") + visible focus rings on every control.
 *     - `aria-live="polite"` announcement on every image change so
 *       screen readers say "Image 3 of 8" without spamming.
 *
 *   The component takes the same `images: ProductImageRow[]` array
 *   that the static gallery uses — there is NO second data layer.
 */
import React, {
  type CSSProperties, type KeyboardEvent, type MouseEvent,
  type PointerEvent, type TouchEvent,
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ProductImageRow } from '@/lib/cms/productGallery';
import type { GalleryInteractionSettings } from '@/lib/cms/productGallery';

interface Props {
  productName:     string;
  images:          ProductImageRow[];
  lazyLoadEnabled: boolean;
  settings:        GalleryInteractionSettings;
}

const SWIPE_THRESHOLD_PX  = 40;   // Min horizontal travel to trigger.
const SWIPE_MAX_VERTICAL  = 30;   // Max vertical drift before we ignore.
const KEY_NAV_TARGETS     = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export default function InteractiveProductGallery({
  productName, images, lazyLoadEnabled, settings,
}: Props) {
  const [activeIdx, setActiveIdx]       = useState<number>(0);
  const [fullscreen, setFullscreen]     = useState<boolean>(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Detect reduced-motion once + on changes. Belt + braces: we ALWAYS
  // respect prefers-reduced-motion regardless of the admin's
  // `transitionMs` value.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(m.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    if (typeof m.addEventListener === 'function') {
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    }
    // Safari < 14 legacy fallback.
    m.addListener(onChange);
    return () => m.removeListener(onChange);
  }, []);

  const total = images.length;
  const safeIdx = Math.min(Math.max(0, activeIdx), Math.max(0, total - 1));
  const active = images[safeIdx];

  // Effective transition: 0 under reduced-motion.
  const effectiveTransitionMs = reducedMotion ? 0 : settings.transitionMs;

  // ── Navigation helpers ───────────────────────────────────────────
  const goTo = useCallback((next: number) => {
    if (total === 0) return;
    let n = next;
    if (settings.loopEnabled) {
      n = ((n % total) + total) % total;
    } else {
      n = Math.max(0, Math.min(total - 1, n));
    }
    setActiveIdx(n);
  }, [total, settings.loopEnabled]);

  const goPrev = useCallback(() => goTo(safeIdx - 1), [goTo, safeIdx]);
  const goNext = useCallback(() => goTo(safeIdx + 1), [goTo, safeIdx]);
  const goHome = useCallback(() => goTo(0),             [goTo]);
  const goEnd  = useCallback(() => goTo(total - 1),     [goTo, total]);

  // ── Keyboard handler on the gallery container ────────────────────
  function onContainerKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!KEY_NAV_TARGETS.has(e.key)) return;
    // Don't hijack typing inside form inputs nested in the gallery.
    const tgt = e.target as HTMLElement;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/i.test(tgt.tagName)) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft')  goPrev();
    else if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'Home')  goHome();
    else if (e.key === 'End')   goEnd();
  }

  // ── Swipe handling — pointer events ──────────────────────────────
  const swipeRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0, y: 0, active: false,
  });
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeRef.current = { x: e.clientX, y: e.clientY, active: true };
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!swipeRef.current.active) return;
    const dx = e.clientX - swipeRef.current.x;
    const dy = e.clientY - swipeRef.current.y;
    swipeRef.current.active = false;
    if (Math.abs(dy) > SWIPE_MAX_VERTICAL) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX)  return;
    if (dx > 0) goPrev(); else goNext();
  }
  // Fallback for browsers/test envs without PointerEvent support.
  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    const t = e.touches[0]; if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY, active: true };
  }
  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    if (!swipeRef.current.active) return;
    const t = e.changedTouches[0]; if (!t) return;
    const dx = t.clientX - swipeRef.current.x;
    const dy = t.clientY - swipeRef.current.y;
    swipeRef.current.active = false;
    if (Math.abs(dy) > SWIPE_MAX_VERTICAL) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX)  return;
    if (dx > 0) goPrev(); else goNext();
  }

  // ── Preload adjacent images (perf) ───────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || total <= 1) return;
    const neighbours: number[] = [];
    if (safeIdx + 1 < total)               neighbours.push(safeIdx + 1);
    if (safeIdx - 1 >= 0)                  neighbours.push(safeIdx - 1);
    if (settings.loopEnabled) {
      if (safeIdx === total - 1)           neighbours.push(0);
      if (safeIdx === 0)                   neighbours.push(total - 1);
    }
    for (const i of neighbours) {
      const url = images[i]?.url;
      if (!url) continue;
      const img = new window.Image();
      img.decoding = 'async';
      img.src = url;
    }
  }, [safeIdx, total, images, settings.loopEnabled]);

  // ── Zoom on the main image (desktop hover / mobile tap) ──────────
  const [zoomOn, setZoomOn]       = useState<boolean>(false);
  const [zoomPos, setZoomPos]     = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const canZoom = settings.zoomEnabled && !reducedMotion;
  function onZoomMove(e: MouseEvent<HTMLDivElement>) {
    if (!canZoom || !zoomOn) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width)  * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - r.top)  / r.height) * 100));
    setZoomPos({ x, y });
  }
  function onZoomEnter() { if (canZoom) setZoomOn(true); }
  function onZoomLeave() { if (zoomOn) setZoomOn(false); }
  function onMainTap()   { if (canZoom) setZoomOn((p) => !p); }

  // Reset zoom when active image changes.
  useEffect(() => { setZoomOn(false); }, [safeIdx]);

  // ── Fullscreen lightbox ──────────────────────────────────────────
  const canFullscreen = settings.fullscreenEnabled && total > 0;
  function openFullscreen() { if (canFullscreen) setFullscreen(true); }
  function closeFullscreen() { setFullscreen(false); }

  // ── Render guards ────────────────────────────────────────────────
  if (total === 0 || !active) {
    return (
      <div
        className="space-y-3"
        data-testid="product-gallery"
        data-product-image-count="0"
      >
        <div className="grid aspect-square w-full place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-400">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider">No image</p>
            <p className="mt-1 text-[11px]">{productName}</p>
          </div>
        </div>
      </div>
    );
  }

  // Layout: thumbs bottom (default) OR left on desktop (still bottom on mobile).
  const leftThumbs = settings.thumbnailPosition === 'left';
  const containerLayout = leftThumbs
    ? 'flex flex-col-reverse gap-3 sm:flex-row'
    : 'flex flex-col gap-3';

  const mainTransitionStyle: CSSProperties = effectiveTransitionMs > 0
    ? { transition: `opacity ${effectiveTransitionMs}ms ease-out` }
    : {};
  const zoomStyle: CSSProperties = zoomOn
    ? {
        transform: `scale(2)`,
        transformOrigin: `${zoomPos.x}% ${zoomPos.y}%`,
        transition: effectiveTransitionMs > 0 ? `transform ${effectiveTransitionMs}ms ease-out` : 'none',
        cursor: 'zoom-out',
      }
    : {
        transform: 'scale(1)',
        transformOrigin: '50% 50%',
        transition: effectiveTransitionMs > 0 ? `transform ${effectiveTransitionMs}ms ease-out` : 'none',
        cursor: canZoom ? 'zoom-in' : 'default',
      };

  return (
    <section
      ref={containerRef}
      className={`space-y-3 ${leftThumbs ? '' : ''}`}
      aria-label={`${productName} — image gallery`}
      data-testid="product-gallery"
      data-product-image-count={String(total)}
      data-gallery-mode="interactive"
      data-active-index={String(safeIdx)}
      tabIndex={-1}
      onKeyDown={onContainerKeyDown}
    >
      {/* Screen-reader live region: announces "Image 3 of 8". */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="gallery-status">
        Image {safeIdx + 1} of {total}{active.alt ? `: ${active.alt}` : ''}
      </p>

      <div className={containerLayout}>
        {/* ── Main image area with swipe + zoom + fullscreen ──────── */}
        <div className="relative flex-1">
          <div
            className="group relative aspect-square w-full overflow-hidden rounded-xl border border-slate-200 bg-white sm:aspect-[3/2]"
            data-testid="product-gallery-main"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onMouseEnter={onZoomEnter}
            onMouseLeave={onZoomLeave}
            onMouseMove={onZoomMove}
            onClick={onMainTap}
            style={mainTransitionStyle}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={active.id}
              src={active.url}
              alt={active.alt ?? productName}
              className="h-full w-full select-none object-contain"
              draggable={false}
              loading="eager"
              decoding="async"
              data-product-image-id={active.id}
              data-product-image-primary={String(active.isPrimary)}
              data-testid="product-gallery-main-img"
              style={zoomStyle}
              {...({ fetchpriority: 'high' } as Record<string, string>)}
            />

            {/* Counter overlay */}
            {total > 1 && (
              <span
                className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-semibold text-white backdrop-blur-sm"
                data-testid="gallery-counter"
                aria-hidden="true"
              >
                {safeIdx + 1} / {total}
              </span>
            )}

            {/* Prev / Next buttons (visible on hover on desktop, always on mobile) */}
            {total > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous image"
                  onClick={(e) => { e.stopPropagation(); goPrev(); }}
                  disabled={!settings.loopEnabled && safeIdx === 0}
                  className="tap-target absolute left-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-slate-200 bg-white/90 text-slate-900 shadow opacity-100 transition disabled:opacity-30 hover:bg-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
                  data-testid="gallery-prev"
                >
                  <span aria-hidden="true">‹</span>
                </button>
                <button
                  type="button"
                  aria-label="Next image"
                  onClick={(e) => { e.stopPropagation(); goNext(); }}
                  disabled={!settings.loopEnabled && safeIdx === total - 1}
                  className="tap-target absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-slate-200 bg-white/90 text-slate-900 shadow opacity-100 transition disabled:opacity-30 hover:bg-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
                  data-testid="gallery-next"
                >
                  <span aria-hidden="true">›</span>
                </button>
              </>
            )}

            {/* Fullscreen affordance */}
            {canFullscreen && (
              <button
                type="button"
                aria-label="View image fullscreen"
                onClick={(e) => { e.stopPropagation(); openFullscreen(); }}
                className="tap-target absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-white/90 text-slate-900 shadow transition hover:bg-white"
                data-testid="gallery-fullscreen"
              >
                <span aria-hidden="true">⤢</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Thumbnail rail (tablist) ──────────────────────────────── */}
        {total > 1 && (
          <div
            role="tablist"
            aria-label={`All images of ${productName}`}
            className={
              leftThumbs
                ? 'grid grid-cols-5 gap-2 sm:order-first sm:flex sm:max-h-[28rem] sm:w-20 sm:flex-col sm:overflow-y-auto lg:w-24'
                : 'grid grid-cols-5 gap-2 sm:grid-cols-6 lg:grid-cols-8'
            }
            data-testid="product-gallery-thumbs"
          >
            {images.map((image, idx) => {
              const selected = idx === safeIdx;
              return (
                <button
                  key={image.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-current={selected ? 'true' : undefined}
                  aria-controls="product-gallery-main"
                  aria-label={`Show image ${idx + 1}${image.alt ? `: ${image.alt}` : ''}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => goTo(idx)}
                  data-product-image-id={image.id}
                  data-product-image-primary={String(image.isPrimary)}
                  data-testid="product-gallery-thumb"
                  data-thumb-index={String(idx)}
                  className={
                    'block overflow-hidden rounded-md border bg-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ' +
                    (selected
                      ? 'border-brand-500 ring-2 ring-brand-200'
                      : 'border-slate-200 hover:border-slate-400')
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt=""
                    className="aspect-square w-full object-cover"
                    loading={selected ? 'eager' : (lazyLoadEnabled ? 'lazy' : 'eager')}
                    decoding="async"
                    draggable={false}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {fullscreen && active && (
        <FullscreenLightbox
          productName={productName}
          images={images}
          activeIdx={safeIdx}
          loopEnabled={settings.loopEnabled}
          transitionMs={effectiveTransitionMs}
          onClose={closeFullscreen}
          onSelect={goTo}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// FULLSCREEN LIGHTBOX — focus-trapped native <dialog>
// ─────────────────────────────────────────────────────────────────────────

interface LightboxProps {
  productName:  string;
  images:       ProductImageRow[];
  activeIdx:    number;
  loopEnabled:  boolean;
  transitionMs: number;
  onClose:      () => void;
  onSelect:     (idx: number) => void;
}

function FullscreenLightbox({
  productName, images, activeIdx, loopEnabled, transitionMs, onClose, onSelect,
}: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [localIdx, setLocalIdx] = useState<number>(activeIdx);

  useEffect(() => { setLocalIdx(activeIdx); }, [activeIdx]);

  // Show modal + restore focus.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const previouslyFocused = (typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
    try {
      // showModal handles focus-trap + Escape + top-layer natively.
      if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    } catch { /* already-open or unsupported */ }
    // Lock background scroll.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      try { if (dlg.open) dlg.close(); } catch { /* */ }
      previouslyFocused?.focus?.();
    };
  }, []);

  const total = images.length;
  const safe = Math.max(0, Math.min(total - 1, localIdx));
  const active = images[safe];

  function navigate(next: number) {
    let n = next;
    if (loopEnabled) n = ((n % total) + total) % total;
    else n = Math.max(0, Math.min(total - 1, n));
    setLocalIdx(n);
    onSelect(n);
  }

  function onDialogKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navigate(safe - 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigate(safe + 1); return; }
    if (e.key === 'Home')       { e.preventDefault(); navigate(0); return; }
    if (e.key === 'End')        { e.preventDefault(); navigate(total - 1); return; }
    // Escape is handled natively by <dialog>; we still listen to fire onClose.
    if (e.key === 'Escape') { onClose(); }
  }

  function onBackdropClick(e: MouseEvent<HTMLDialogElement>) {
    // Click on the <dialog> itself (not its inner content) → close.
    if (e.target === dialogRef.current) onClose();
  }

  if (!active) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={onBackdropClick}
      onKeyDown={onDialogKeyDown}
      aria-label={`${productName} — fullscreen image viewer`}
      data-testid="gallery-lightbox"
      className="m-0 h-full max-h-screen w-full max-w-screen-2xl bg-black/95 p-0 text-white backdrop:bg-black/85"
    >
      <div className="flex h-full w-full flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-white/60">{productName}</p>
            <p className="text-sm font-semibold" data-testid="lightbox-counter">{safe + 1} / {total}</p>
          </div>
          <button
            type="button"
            aria-label="Close fullscreen viewer"
            onClick={onClose}
            data-testid="lightbox-close"
            className="tap-target rounded-md border border-white/30 bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20"
          >Close ✕</button>
        </header>

        <div className="relative flex-1 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={active.id}
            src={active.url}
            alt={active.alt ?? productName}
            data-testid="lightbox-main-img"
            data-product-image-id={active.id}
            className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
            style={transitionMs > 0 ? { transition: `opacity ${transitionMs}ms ease-out` } : undefined}
            draggable={false}
          />

          {total > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => navigate(safe - 1)}
                disabled={!loopEnabled && safe === 0}
                data-testid="lightbox-prev"
                className="tap-target absolute left-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-white/10 text-2xl hover:bg-white/20 disabled:opacity-30"
              ><span aria-hidden="true">‹</span></button>
              <button
                type="button"
                aria-label="Next image"
                onClick={() => navigate(safe + 1)}
                disabled={!loopEnabled && safe === total - 1}
                data-testid="lightbox-next"
                className="tap-target absolute right-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-white/10 text-2xl hover:bg-white/20 disabled:opacity-30"
              ><span aria-hidden="true">›</span></button>
            </>
          )}
        </div>

        {total > 1 && (
          <footer className="border-t border-white/10 px-4 py-2">
            <div
              role="tablist"
              aria-label="Thumbnail navigation"
              className="flex gap-2 overflow-x-auto"
              data-testid="lightbox-thumbs"
            >
              {images.map((image, idx) => {
                const selected = idx === safe;
                return (
                  <button
                    key={image.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={`Show image ${idx + 1}`}
                    onClick={() => navigate(idx)}
                    data-thumb-index={String(idx)}
                    className={
                      'h-16 w-16 flex-shrink-0 overflow-hidden rounded border transition ' +
                      (selected
                        ? 'border-white ring-2 ring-white'
                        : 'border-white/30 opacity-60 hover:opacity-100')
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image.url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              Image {safe + 1} of {total}{active.alt ? `: ${active.alt}` : ''}
            </p>
          </footer>
        )}
      </div>
    </dialog>
  );
}
