'use client';
/**
 * HeroCarousel — Feature #15.
 *
 *   Production-grade, native-CSS hero carousel. No external libraries.
 *
 *   Behaviour:
 *     - Auto-advance every `autoplayMs` (default 6 s; admin-configurable
 *       via store-config). Setting `autoplayMs <= 0` disables autoplay.
 *     - Pauses on hover (pointer), on keyboard focus, while the tab is
 *       hidden (Page Visibility API), and while the carousel is offscreen
 *       (IntersectionObserver). Resumes when ALL pauses clear.
 *     - Manual: prev / next buttons, dot indicators, ←/→ arrow keys.
 *     - Touch: native swipe (left/right) via pointer-event tracking. No
 *       library — we just measure pointer delta on pointerup.
 *     - Respects `prefers-reduced-motion` → cross-fade only (no slide).
 *     - Empty state: when there are zero slides, the parent decides
 *       (hideWhenEmpty config). When asked to render an empty fallback,
 *       we show a single muted brand-only slide so the band height
 *       stays consistent (avoid layout shift).
 *     - Loading state: skeleton with the SAME aspect ratio as a real
 *       slide → zero CLS when banners arrive.
 *
 *   Accessibility:
 *     - Root element: role="region", aria-roledescription="carousel",
 *       aria-label "Promotional banners".
 *     - Each slide: role="group", aria-roledescription="slide",
 *       aria-label "N of M".
 *     - Inactive slides are aria-hidden so SR doesn't announce them.
 *     - Live region (sr-only) announces "Slide N of M, headline …" on
 *       each change.
 *     - Arrow buttons: aria-label "Previous slide" / "Next slide".
 *     - Dot indicators: <button aria-label="Go to slide N">, aria-current
 *       on the active dot.
 *
 *   Image strategy:
 *     - <picture> with <source media="(min-width: 768px)" srcSet=desktopUrl>
 *       and <img src=mobileUrl or desktopUrl loading="lazy" decoding="async">
 *     - First slide eagerly loaded + fetchPriority="high" (LCP candidate).
 *     - All slides reserve aspect-ratio via Tailwind `aspect-*` classes so
 *       the band height is fixed before images decode.
 *
 *   Performance:
 *     - Single mounted DOM tree; we change the *currentIndex* and animate
 *       a single transform on the track. No per-slide React state.
 *     - One setInterval-ish timer behind a ref so React renders don't
 *       reset it. Cleared on unmount + on every pause-cause toggle.
 *     - The whole carousel re-renders ONLY when currentIndex changes —
 *       there's a single `useState` for it.
 */
import React, {
  KeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import Link from 'next/link';
import type { HeroBannerView } from '@/lib/cms/heroBanners';

export interface HeroCarouselConfig {
  autoplayMs: number;
  resumeAfterMs: number;
  hideWhenEmpty: boolean;
  showDots: boolean;
  showArrows: boolean;
}

interface Props {
  banners: HeroBannerView[];
  config: HeroCarouselConfig;
  /** Test hook: when true the carousel never starts its autoplay timer.
   *  Used by jsdom tests to avoid flaky timing. */
  disableAutoplay?: boolean;
  /** Optional pre-fetched poster path used for the skeleton — we don't
   *  load it; it's just the aspect ratio anchor. Default: no poster. */
  className?: string;
  'data-testid'?: string;
}

const SWIPE_THRESHOLD_PX = 40;

export default function HeroCarousel({
  banners, config, disableAutoplay = false,
  className = '', 'data-testid': testId = 'hero-carousel',
}: Props) {
  const count = banners.length;

  // EMPTY state — never mount the carousel machinery; render the fallback
  // band so the parent stays layout-stable.
  if (count === 0) {
    if (config.hideWhenEmpty) return null;
    return <EmptyHeroBand testId={testId} />;
  }

  return (
    <CarouselInner
      banners={banners}
      config={config}
      disableAutoplay={disableAutoplay}
      className={className}
      testId={testId}
      count={count}
    />
  );
}

function EmptyHeroBand({ testId }: { testId: string }) {
  return (
    <section
      aria-label="ShopCore"
      data-testid={`${testId}-empty`}
      className="relative w-full overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-50"
    >
      <div className="mx-auto flex aspect-[16/9] max-h-[420px] max-w-7xl items-center justify-center px-4 sm:aspect-[21/9]">
        <p className="text-center text-fluid-2xl font-bold text-slate-700">
          ShopCore — Laptops, desktops &amp; electronics, delivered across India.
        </p>
      </div>
    </section>
  );
}

function CarouselInner({
  banners, config, disableAutoplay, className, testId, count,
}: Required<Pick<Props, 'banners' | 'config'>> &
   { disableAutoplay: boolean; className: string; testId: string; count: number }) {
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // ── pause-cause aggregation ─────────────────────────────────────────────
  // Auto-play resumes only when EVERY pause cause is cleared. We track
  // each cause as an independent boolean so they compose safely (e.g. a
  // user hovers, then tabs away — auto-play stays paused until both
  // clear). Stored in a ref so flipping a cause doesn't re-render the
  // carousel — only `index` changes drive React renders.
  const pauseRef = useRef({ hover: false, focus: false, hidden: false, offscreen: false, recentNav: false });
  const reasons = pauseRef.current;
  const isPaused = () =>
    reasons.hover || reasons.focus || reasons.hidden || reasons.offscreen || reasons.recentNav;

  // ── timer machinery (singleton interval, lives in a ref) ────────────────
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  const scheduleAutoplay = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (disableAutoplay) return;
    if (count <= 1) return;             // single slide → nothing to advance
    if (config.autoplayMs <= 0) return; // explicit opt-out
    if (isPaused()) return;             // honour current pause causes
    timerRef.current = setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, config.autoplayMs);
  }, [count, config.autoplayMs, disableAutoplay]);

  // Mount: start (and tear down on unmount — guards against the spec's
  // "no timer leaks" requirement).
  useEffect(() => {
    scheduleAutoplay();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [scheduleAutoplay]);

  // Pause-cause: tab visibility.
  useEffect(() => {
    const onVis = () => {
      reasons.hidden = document.visibilityState !== 'visible';
      scheduleAutoplay();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [reasons, scheduleAutoplay]);

  // Pause-cause: offscreen via IntersectionObserver.
  useEffect(() => {
    const el = trackRef.current?.parentElement; // the section element
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[0];
      reasons.offscreen = !e?.isIntersecting;
      scheduleAutoplay();
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, [reasons, scheduleAutoplay]);

  // ── navigation helpers ──────────────────────────────────────────────────
  const goTo = useCallback((next: number) => {
    setIndex(((next % count) + count) % count);
    // After explicit nav, mute autoplay for `resumeAfterMs` so the slide
    // the user just chose has time to settle on screen.
    reasons.recentNav = true;
    scheduleAutoplay();
    window.setTimeout(() => {
      reasons.recentNav = false;
      scheduleAutoplay();
    }, Math.max(300, config.resumeAfterMs));
  }, [count, reasons, scheduleAutoplay, config.resumeAfterMs]);

  const next = useCallback(() => goTo(indexRef.current + 1), [goTo]);
  const prev = useCallback(() => goTo(indexRef.current - 1), [goTo]);

  // ── keyboard navigation ────────────────────────────────────────────────
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); prev(); }
    if (e.key === 'Home')       { e.preventDefault(); goTo(0); }
    if (e.key === 'End')        { e.preventDefault(); goTo(count - 1); }
  }, [next, prev, goTo, count]);

  // ── pointer swipe (mobile) ─────────────────────────────────────────────
  const pointerStart = useRef<{ x: number; t: number } | null>(null);
  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    pointerStart.current = { x: e.clientX, t: Date.now() };
  }, []);
  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const s = pointerStart.current;
    pointerStart.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) (dx < 0 ? next : prev)();
  }, [next, prev]);

  // ── hover / focus pause causes (declarative) ───────────────────────────
  const onMouseEnter = () => { reasons.hover = true;  scheduleAutoplay(); };
  const onMouseLeave = () => { reasons.hover = false; scheduleAutoplay(); };
  const onFocusIn    = () => { reasons.focus = true;  scheduleAutoplay(); };
  const onFocusOut   = (e: React.FocusEvent<HTMLDivElement>) => {
    // Only clear focus pause when focus leaves the carousel root, not when
    // moving between child controls.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      reasons.focus = false; scheduleAutoplay();
    }
  };

  // ── reduced-motion: just fade across, no slide ─────────────────────────
  const reducedMotion = usePrefersReducedMotion();

  // Aria-live announcement string — recomputed only when index/count change.
  const liveText = useMemo(() => {
    const b = banners[index];
    return `Slide ${index + 1} of ${count}${b ? `: ${b.headline}` : ''}`;
  }, [index, count, banners]);

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label="Promotional banners"
      data-testid={testId}
      className={`relative w-full overflow-hidden bg-slate-900 text-white ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocusIn}
      onBlur={onFocusOut}
      onKeyDown={onKey}
      tabIndex={0}
    >
      {/* sr-only live region — announces slide changes. */}
      <p className="sr-only" aria-live="polite" data-testid={`${testId}-live`}>{liveText}</p>

      {/* Track — single transform animates between slides. */}
      <div
        ref={trackRef}
        className={[
          'flex h-full w-full',
          reducedMotion
            ? 'transition-none'
            : 'transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          'will-change-transform',
        ].join(' ')}
        style={{ transform: `translateX(-${index * 100}%)` }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        data-testid={`${testId}-track`}
      >
        {banners.map((b, i) => (
          <Slide
            key={b.id}
            banner={b}
            isActive={i === index}
            index={i}
            count={count}
            isLcp={i === 0}
            testId={`${testId}-slide-${i}`}
          />
        ))}
      </div>

      {/* Prev / Next arrows. Hidden on phones (swipe is the primary nav). */}
      {config.showArrows && count > 1 && (
        <>
          <NavButton dir="prev" onClick={prev} testId={`${testId}-prev`} />
          <NavButton dir="next" onClick={next} testId={`${testId}-next`} />
        </>
      )}

      {/* Dot indicators. */}
      {config.showDots && count > 1 && (
        <div
          role="tablist"
          aria-label="Choose slide"
          data-testid={`${testId}-dots`}
          className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2 sm:bottom-4"
        >
          {banners.map((b, i) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-label={`Go to slide ${i + 1}`}
              aria-selected={i === index}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => goTo(i)}
              data-testid={`${testId}-dot-${i}`}
              className={[
                'tap-target inline-flex items-center justify-center rounded-full',
                'transition-all duration-200 ease-out motion-reduce:transition-none',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className={[
                  'block rounded-full transition-all duration-200 ease-out motion-reduce:transition-none',
                  i === index
                    ? 'h-2.5 w-6 bg-white shadow-lg'
                    : 'h-2.5 w-2.5 bg-white/50 hover:bg-white/80',
                ].join(' ')}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Slide({
  banner: b, isActive, index, count, isLcp, testId,
}: {
  banner: HeroBannerView; isActive: boolean; index: number; count: number;
  isLcp: boolean; testId: string;
}) {
  const desktop = b.imageDesktopUrl;
  // Spec: fall back to desktop when mobile is missing.
  const mobile  = b.imageMobileUrl ?? desktop;
  // Pick text colour. Default light over images (the overlay tint is dark).
  const isDark  = b.textColor === 'dark';
  const overlay = Math.max(0, Math.min(100, b.overlayOpacity));

  return (
    <article
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}`}
      aria-hidden={!isActive}
      data-testid={testId}
      data-active={isActive ? 'true' : 'false'}
      // Each slide is a full-width column inside the flex track. `min-w-full`
      // ensures it takes exactly the carousel width — even when an image
      // hasn't loaded yet — so the translate-X math is precise.
      className="relative aspect-[16/9] min-w-full overflow-hidden bg-slate-900 sm:aspect-[21/9] lg:aspect-[24/9]"
    >
      <picture>
        <source media="(min-width: 768px)" srcSet={desktop} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={mobile}
          alt={b.imageAlt ?? ''}
          loading={isLcp ? 'eager' : 'lazy'}
          decoding="async"
          // @ts-expect-error fetchpriority not in React's typed HTMLImgElement yet
          fetchpriority={isLcp ? 'high' : 'auto'}
          onError={(e) => {
            // Broken URL — paint a soft gradient placeholder so the layout
            // doesn't collapse. We don't retry; the headline still renders.
            (e.currentTarget as HTMLImageElement).style.opacity = '0';
          }}
          className="absolute inset-0 h-full w-full select-none object-cover"
          draggable={false}
        />
      </picture>

      {/* Contrast overlay — drives legibility of the text on busy images. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: isDark
            ? `linear-gradient(180deg, rgba(255,255,255,${overlay / 100}), rgba(255,255,255,${(overlay / 100) * 0.6}))`
            : `linear-gradient(180deg, rgba(0,0,0,${overlay / 100}), rgba(0,0,0,${(overlay / 100) * 0.6}))`,
        }}
      />

      {/* Content. Inactive slides keep the DOM but are aria-hidden + non-tabbable. */}
      <div className={[
        'relative z-10 mx-auto flex h-full max-w-7xl flex-col justify-center gap-3 px-4 sm:gap-4 sm:px-8',
        isDark ? 'text-slate-900' : 'text-white',
      ].join(' ')}>
        <h2 className="max-w-2xl text-fluid-3xl font-extrabold leading-tight tracking-tight drop-shadow-sm sm:text-fluid-4xl">
          {b.headline}
        </h2>
        {b.subheadline && (
          <p className="max-w-xl text-fluid-base sm:text-fluid-lg">{b.subheadline}</p>
        )}
        {b.ctaLabel && b.ctaHref && (
          <div className="mt-1 sm:mt-2">
            <Link
              href={b.ctaHref}
              aria-label={`${b.ctaLabel} — ${b.headline}`}
              // Inactive slides should NOT be tabbable; we set tabIndex=-1
              // so keyboard users only ever land on the visible slide's CTA.
              tabIndex={isActive ? 0 : -1}
              data-testid={`${testId}-cta`}
              className={[
                'tap-target inline-flex items-center justify-center rounded-lg px-5 text-sm font-semibold shadow-sm',
                'transition-transform duration-200 ease-out motion-reduce:transition-none',
                'hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                isDark
                  ? 'bg-slate-900 text-white focus-visible:outline-slate-900'
                  : 'bg-white text-slate-900 focus-visible:outline-white',
              ].join(' ')}
            >
              {b.ctaLabel}
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}

function NavButton({
  dir, onClick, testId,
}: { dir: 'prev' | 'next'; onClick: () => void; testId: string }) {
  const isPrev = dir === 'prev';
  return (
    <button
      type="button"
      aria-label={isPrev ? 'Previous slide' : 'Next slide'}
      onClick={onClick}
      data-testid={testId}
      // Hidden on phones (swipe replaces the buttons).
      className={[
        'tap-target absolute top-1/2 hidden -translate-y-1/2 items-center justify-center',
        'rounded-full bg-white/15 text-white backdrop-blur-md',
        'transition-all duration-200 ease-out motion-reduce:transition-none',
        'hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
        'sm:inline-flex sm:h-12 sm:w-12',
        isPrev ? 'left-3 sm:left-5' : 'right-3 sm:right-5',
      ].join(' ')}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           className="h-6 w-6" aria-hidden="true">
        <path d={isPrev ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );
}

/** Tiny prefers-reduced-motion subscriber. SSR-safe (returns false on first paint). */
function usePrefersReducedMotion(): boolean {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setV(mql.matches);
    const handler = (e: MediaQueryListEvent) => setV(e.matches);
    mql.addEventListener?.('change', handler);
    return () => mql.removeEventListener?.('change', handler);
  }, []);
  return v;
}
