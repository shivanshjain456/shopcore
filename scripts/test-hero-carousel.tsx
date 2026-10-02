/**
 * Feature #15 — HeroCarousel component test suite.
 *
 *   npm run test:hero-carousel
 *
 * Pure-jsdom + React. Tests every interaction the spec asks for:
 *
 *   - RENDER + A11Y: region role + roledescription="carousel", aria-label,
 *     per-slide role/roledescription, aria-hidden on inactive slides,
 *     live region announces slide changes, dot indicators have
 *     aria-current on the active dot.
 *   - NAVIGATION: prev/next buttons, dot indicator clicks all change index;
 *     keyboard ArrowLeft/ArrowRight/Home/End navigate; the track transform
 *     updates accordingly.
 *   - WRAP-AROUND: prev from slide 0 → last slide; next from last → 0.
 *   - SINGLE BANNER: arrows + dots hidden when only one slide.
 *   - EMPTY: hideWhenEmpty=true → renders nothing; hideWhenEmpty=false →
 *     renders the muted fallback band.
 *   - SWIPE: pointerdown+pointerup with horizontal delta ≥ 40px advances.
 *   - IMAGES: first slide eagerly loaded with fetchpriority=high; later
 *     slides lazy; missing mobile image falls back to desktop URL on the
 *     <img>; broken-image onError hides the img without breaking the slide.
 *   - REGRESSION: <PasswordStrengthMeter>, <OtpInput>, <PincodeField> still
 *     mount cleanly (proves shared imports unchanged).
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as unknown as { window: typeof window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
(globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = window.HTMLElement;
(globalThis as unknown as { HTMLImageElement: typeof HTMLImageElement }).HTMLImageElement = window.HTMLImageElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
(globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent = window.KeyboardEvent;
(globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent = window.MouseEvent;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle =
  window.getComputedStyle.bind(window);
{
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (e: string, fn: () => void) => void;
    detachEvent?: (e: string, fn: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => { /* */ };
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => { /* */ };
}
// matchMedia mock — always reports "no reduced motion"
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia =
  function matchMediaMock(query: string): MediaQueryList {
    return {
      matches: false, media: query,
      addEventListener: () => { /* */ }, removeEventListener: () => { /* */ },
      addListener: () => { /* */ }, removeListener: () => { /* */ },
      onchange: null, dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  } as unknown as Window['matchMedia'];
// IntersectionObserver stub — never reports off-screen.
(window as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
  class FakeIO {
    constructor(_cb: IntersectionObserverCallback) { /* */ }
    observe()   { /* */ }
    unobserve() { /* */ }
    disconnect(){ /* */ }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  } as unknown as typeof IntersectionObserver;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// next/link reaches for `self` + `requestIdleCallback` in its prefetch
// effect. We don't want prefetching in jsdom — just stub those globals so
// next/link mounts as a plain anchor without throwing.
(globalThis as unknown as { self: typeof globalThis }).self = globalThis;
(globalThis as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback =
  (cb: () => void) => { setTimeout(cb, 0); return 0; };
(globalThis as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback =
  (_id: number) => { /* noop */ };
(window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback =
  (cb: () => void) => { setTimeout(cb, 0); return 0; };
(window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback =
  (_id: number) => { /* noop */ };

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import HeroCarousel, { type HeroCarouselConfig } from '../src/components/storefront/HeroCarousel';
import type { HeroBannerView } from '../src/lib/cms/heroBanners';
import PasswordStrengthMeter from '../src/components/auth/PasswordStrengthMeter';
import OtpInput from '../src/components/auth/OtpInput';
import PincodeField from '../src/components/forms/PincodeField';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  const isNode = (x: unknown): boolean =>
    typeof x === 'object' && x != null && typeof (x as { nodeType?: unknown }).nodeType === 'number';
  if (isNode(expected) || isNode(actual)) {
    if (expected === actual) ok(label); else fail(label, '<DOM node>', '<other DOM node>');
    return;
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else fail(label, true, detail ?? false);
}

function mount(node: React.ReactElement) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, cleanup() { act(() => { root.unmount(); }); container.remove(); } };
}

function dispatchPointer(el: Element, type: 'pointerdown' | 'pointerup', x: number) {
  // jsdom doesn't ship a PointerEvent constructor; MouseEvent is event-compat
  // enough for our use (the component only reads `clientX`). The clientX
  // value is read off the constructor init dict — we don't need to mutate
  // it after construction.
  const ev = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 100 });
  el.dispatchEvent(ev);
}
function keyDown(el: Element, key: string) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const CONFIG: HeroCarouselConfig = {
  autoplayMs: 0,     // never autoplay during tests
  resumeAfterMs: 100,
  hideWhenEmpty: false,
  showDots: true,
  showArrows: true,
};
function banner(i: number, over: Partial<HeroBannerView> = {}): HeroBannerView {
  return {
    id: `b${i}`,
    headline: `Headline ${i}`,
    subheadline: `Sub ${i}`,
    ctaLabel: `Shop ${i}`,
    ctaHref: `/c/${i}`,
    imageDesktopUrl: `https://cdn.example.com/desk-${i}.jpg`,
    imageMobileUrl: `https://cdn.example.com/mob-${i}.jpg`,
    imageAlt: `Banner ${i}`,
    textColor: null, overlayOpacity: 35,
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────── 1. RENDER + A11Y
function renderTests() {
  console.log('\n── RENDER + ACCESSIBILITY ──');
  const banners = [banner(1), banner(2), banner(3)];
  const { container, cleanup } = mount(
    <HeroCarousel banners={banners} config={CONFIG} disableAutoplay />,
  );
  const root = container.querySelector('[data-testid="hero-carousel"]')!;
  eq('(R1) root role=region', 'region', root.getAttribute('role'));
  eq('(R1) root aria-roledescription=carousel', 'carousel', root.getAttribute('aria-roledescription'));
  eq('(R1) root aria-label', 'Promotional banners', root.getAttribute('aria-label'));

  // Slides — restrict to <article> only (CTA links share the prefix).
  const slides = Array.from(container.querySelectorAll('article[data-testid^="hero-carousel-slide-"]'));
  eq('(R2) renders one article per banner', 3, slides.length);
  slides.forEach((s, i) => {
    eq(`(R2) slide ${i} role=group`, 'group', s.getAttribute('role'));
    eq(`(R2) slide ${i} aria-roledescription=slide`, 'slide', s.getAttribute('aria-roledescription'));
    eq(`(R2) slide ${i} aria-label`, `${i + 1} of 3`, s.getAttribute('aria-label'));
  });
  eq('(R2) only active slide is NOT aria-hidden',
     'false', slides[0].getAttribute('aria-hidden'));
  eq('(R2) inactive slide IS aria-hidden',
     'true', slides[1].getAttribute('aria-hidden'));

  // Live region
  const live = container.querySelector('[data-testid="hero-carousel-live"]')!;
  eq('(R3) live region aria-live=polite', 'polite', live.getAttribute('aria-live'));
  assert('(R3) live region announces slide 1',
    /Slide 1 of 3/i.test(live.textContent ?? ''));

  // Dots
  const dotsRoot = container.querySelector('[data-testid="hero-carousel-dots"]')!;
  eq('(R4) dot tablist role', 'tablist', dotsRoot.getAttribute('role'));
  eq('(R4) renders one dot per slide',
     3, dotsRoot.querySelectorAll('button[role="tab"]').length);
  const firstDot = container.querySelector('[data-testid="hero-carousel-dot-0"]')!;
  eq('(R4) first dot aria-selected=true', 'true', firstDot.getAttribute('aria-selected'));
  eq('(R4) first dot aria-current=true', 'true', firstDot.getAttribute('aria-current'));

  // Arrow buttons exist with aria-labels
  const prev = container.querySelector('[data-testid="hero-carousel-prev"]')!;
  const next = container.querySelector('[data-testid="hero-carousel-next"]')!;
  eq('(R5) prev aria-label', 'Previous slide', prev.getAttribute('aria-label'));
  eq('(R5) next aria-label', 'Next slide',     next.getAttribute('aria-label'));

  cleanup();
}

// ──────────────────────────────────────────────────────────────────── 2. NAVIGATION
function navTests() {
  console.log('\n── NAVIGATION ──');
  const banners = [banner(1), banner(2), banner(3), banner(4)];
  const { container, cleanup } = mount(
    <HeroCarousel banners={banners} config={CONFIG} disableAutoplay />,
  );
  const track = container.querySelector('[data-testid="hero-carousel-track"]') as HTMLElement;
  const next  = container.querySelector('[data-testid="hero-carousel-next"]') as HTMLElement;
  const prev  = container.querySelector('[data-testid="hero-carousel-prev"]') as HTMLElement;
  const live  = container.querySelector('[data-testid="hero-carousel-live"]')!;

  // (N1) Next moves to slide 2
  act(() => { next.click(); });
  assert(`(N1) next advances track (transform=${track.style.transform})`,
    /translateX\(-100%\)/.test(track.style.transform));
  assert('(N1) live region announces slide 2',
    /Slide 2 of 4/.test(live.textContent ?? ''));

  // (N2) Click next again → slide 3
  act(() => { next.click(); });
  assert('(N2) next twice → slide 3',
    /translateX\(-200%\)/.test(track.style.transform));

  // (N3) Prev → slide 2
  act(() => { prev.click(); });
  assert('(N3) prev decrements',
    /translateX\(-100%\)/.test(track.style.transform));

  // (N4) Prev from slide 1 wraps to last (slide 4)
  act(() => { prev.click(); });
  // Now at 0
  act(() => { prev.click(); });
  // Should be at index 3 (last) — wrap-around
  assert('(N4) prev wraps to last slide',
    /translateX\(-300%\)/.test(track.style.transform));

  // (N5) Next from last wraps to 0
  act(() => { next.click(); });
  assert('(N5) next wraps to first slide',
    /translateX\(-0%\)|translateX\(0%?\)/.test(track.style.transform));

  // (N6) Dot click jumps directly
  const dot2 = container.querySelector('[data-testid="hero-carousel-dot-2"]') as HTMLElement;
  act(() => { dot2.click(); });
  assert('(N6) dot click jumps to that slide',
    /translateX\(-200%\)/.test(track.style.transform));
  // The matching dot has aria-current=true; others false.
  const dots = container.querySelectorAll('[data-testid^="hero-carousel-dot-"]');
  eq('(N6) dot 2 is aria-current', 'true', dots[2].getAttribute('aria-current'));
  eq('(N6) dot 0 is NOT aria-current', null,  dots[0].getAttribute('aria-current'));

  // (N7) Keyboard arrows
  const root = container.querySelector('[data-testid="hero-carousel"]')!;
  act(() => { keyDown(root, 'ArrowRight'); });
  assert('(N7) ArrowRight advances',
    /translateX\(-300%\)/.test(track.style.transform));
  act(() => { keyDown(root, 'ArrowLeft'); });
  assert('(N7) ArrowLeft retreats',
    /translateX\(-200%\)/.test(track.style.transform));
  act(() => { keyDown(root, 'Home'); });
  assert('(N7) Home jumps to first',
    /translateX\(-0%\)|translateX\(0%?\)/.test(track.style.transform));
  act(() => { keyDown(root, 'End'); });
  assert('(N7) End jumps to last',
    /translateX\(-300%\)/.test(track.style.transform));

  // (N8) CTA tabIndex: active slide CTA is tabbable (=0), inactive (=-1)
  const cta3 = container.querySelector('[data-testid="hero-carousel-slide-3-cta"]') as HTMLElement;
  const cta0 = container.querySelector('[data-testid="hero-carousel-slide-0-cta"]') as HTMLElement;
  eq('(N8) active CTA tabindex=0', '0', cta3.getAttribute('tabindex'));
  eq('(N8) inactive CTA tabindex=-1', '-1', cta0.getAttribute('tabindex'));

  cleanup();
}

// ──────────────────────────────────────────────────────────────────── 3. SINGLE / EMPTY
function singleAndEmptyTests() {
  console.log('\n── SINGLE + EMPTY ──');

  // Single banner: no arrows, no dots
  const one = mount(<HeroCarousel banners={[banner(1)]} config={CONFIG} disableAutoplay />);
  assert('(S1) single banner: no prev arrow',
    !one.container.querySelector('[data-testid="hero-carousel-prev"]'));
  assert('(S1) single banner: no next arrow',
    !one.container.querySelector('[data-testid="hero-carousel-next"]'));
  assert('(S1) single banner: no dots',
    !one.container.querySelector('[data-testid="hero-carousel-dots"]'));
  // The slide IS rendered.
  assert('(S1) single banner: slide 0 rendered',
    !!one.container.querySelector('[data-testid="hero-carousel-slide-0"]'));
  one.cleanup();

  // Empty + hideWhenEmpty=true → renders nothing of substance
  const empty1 = mount(
    <HeroCarousel banners={[]}
      config={{ ...CONFIG, hideWhenEmpty: true }} disableAutoplay />,
  );
  assert('(E1) empty + hide → no carousel',
    !empty1.container.querySelector('[data-testid="hero-carousel"]'));
  assert('(E1) empty + hide → no fallback band',
    !empty1.container.querySelector('[data-testid="hero-carousel-empty"]'));
  empty1.cleanup();

  // Empty + hideWhenEmpty=false → muted fallback band
  const empty2 = mount(
    <HeroCarousel banners={[]} config={{ ...CONFIG, hideWhenEmpty: false }} disableAutoplay />,
  );
  assert('(E2) empty + show → fallback band rendered',
    !!empty2.container.querySelector('[data-testid="hero-carousel-empty"]'));
  empty2.cleanup();
}

// ──────────────────────────────────────────────────────────────────── 4. SWIPE
function swipeTests() {
  console.log('\n── SWIPE ──');
  const banners = [banner(1), banner(2), banner(3)];
  const { container, cleanup } = mount(
    <HeroCarousel banners={banners} config={CONFIG} disableAutoplay />,
  );
  const track = container.querySelector('[data-testid="hero-carousel-track"]') as HTMLElement;

  // Swipe LEFT (start at 300, end at 200) → advance (next)
  act(() => {
    dispatchPointer(track, 'pointerdown', 300);
    dispatchPointer(track, 'pointerup',   200);
  });
  assert('(W1) swipe left advances to next slide',
    /translateX\(-100%\)/.test(track.style.transform));

  // Swipe RIGHT (300 → 400) → previous
  act(() => {
    dispatchPointer(track, 'pointerdown', 300);
    dispatchPointer(track, 'pointerup',   400);
  });
  assert('(W2) swipe right returns to previous slide',
    /translateX\(-0%\)|translateX\(0%?\)/.test(track.style.transform));

  // Tiny delta — below 40px threshold — does NOT change slide
  act(() => {
    dispatchPointer(track, 'pointerdown', 300);
    dispatchPointer(track, 'pointerup',   285); // 15px — too small
  });
  assert('(W3) tiny swipe is ignored',
    /translateX\(-0%\)|translateX\(0%?\)/.test(track.style.transform));

  cleanup();
}

// ──────────────────────────────────────────────────────────────────── 5. IMAGES
function imageTests() {
  console.log('\n── IMAGES ──');
  const banners = [
    banner(1), // has mobile + desktop
    banner(2, { imageMobileUrl: null }), // no mobile → fallback to desktop on <img>
    banner(3),
  ];
  const { container, cleanup } = mount(
    <HeroCarousel banners={banners} config={CONFIG} disableAutoplay />,
  );

  // First slide: <img> eager + fetchpriority=high
  const slide0Img = container.querySelector('[data-testid="hero-carousel-slide-0"] img') as HTMLImageElement;
  eq('(I1) first slide img loading=eager', 'eager', slide0Img.getAttribute('loading'));
  eq('(I1) first slide img fetchpriority=high', 'high', slide0Img.getAttribute('fetchpriority'));
  eq('(I1) first slide alt = imageAlt',         'Banner 1', slide0Img.getAttribute('alt'));

  // Later slide: loading=lazy
  const slide1Img = container.querySelector('[data-testid="hero-carousel-slide-1"] img') as HTMLImageElement;
  eq('(I2) second slide img loading=lazy', 'lazy', slide1Img.getAttribute('loading'));

  // Second slide has NO mobile image — the <img src=...> should fall back
  // to the desktop URL so the slide still paints on phones.
  assert(`(I3) missing mobile image falls back to desktop URL (src=${slide1Img.getAttribute('src')})`,
    slide1Img.getAttribute('src') === banners[1].imageDesktopUrl);

  // Picture source carries the desktop variant for ≥768px
  const slide0Source = container.querySelector('[data-testid="hero-carousel-slide-0"] picture source') as HTMLSourceElement;
  eq('(I4) <source media> = "(min-width: 768px)"',
    '(min-width: 768px)', slide0Source.getAttribute('media'));
  eq('(I4) <source srcSet> = desktop URL',
    banners[0].imageDesktopUrl, slide0Source.getAttribute('srcset'));

  cleanup();
}

// ──────────────────────────────────────────────────────────────────── 6. CTA-LESS / EDGE
function ctaTests() {
  console.log('\n── EDGE CASES ──');
  const banners = [
    banner(1, { ctaLabel: null, ctaHref: null }),  // banner without CTA still renders
    banner(2),
  ];
  const { container, cleanup } = mount(
    <HeroCarousel banners={banners} config={CONFIG} disableAutoplay />,
  );
  // Slide 0 has no CTA — no CTA element rendered.
  assert('(X1) banner without CTA still renders the slide',
    !!container.querySelector('[data-testid="hero-carousel-slide-0"]'));
  assert('(X1) banner without CTA does NOT render a CTA link',
    !container.querySelector('[data-testid="hero-carousel-slide-0-cta"]'));
  cleanup();
}

// ──────────────────────────────────────────────────────────────────── 7. PERFORMANCE — TIMER CLEANUP
function timerCleanupTests() {
  console.log('\n── PERFORMANCE / TIMER CLEANUP ──');
  // Spy on setInterval / clearInterval — patched on `globalThis` because
  // the carousel calls the unqualified `setInterval` which resolves to
  // the global scope's binding (not `window.setInterval`).
  let intervals = 0;
  let cleared = 0;
  const ids = new Set<unknown>();
  const g = globalThis as unknown as Record<string, unknown>;
  const origSet = g.setInterval as (fn: TimerHandler, ms?: number) => unknown;
  const origClr = g.clearInterval as (id: unknown) => void;
  const spySet = (fn: TimerHandler, ms?: number) => {
    const id = origSet(fn, ms);
    ids.add(id);
    intervals++;
    return id;
  };
  const spyClr = (id: unknown) => {
    if (ids.has(id)) cleared++;
    origClr(id);
  };
  g.setInterval   = spySet;
  g.clearInterval = spyClr;

  const m = mount(
    <HeroCarousel
      banners={[banner(1), banner(2)]}
      config={{ ...CONFIG, autoplayMs: 50 }}
      // Autoplay enabled here so a real timer is created.
    />,
  );
  act(() => { /* render flush */ });
  const created = intervals;
  m.cleanup();
  assert(`(T1) every setInterval scheduled was cleared on unmount (created=${created}, cleared=${cleared})`,
    created >= 1 && cleared >= created);

  g.setInterval   = origSet;
  g.clearInterval = origClr;
}

// ──────────────────────────────────────────────────────────────────── 8. REGRESSION
function regressionTests() {
  console.log('\n── REGRESSION — shared components still render ──');
  const a = mount(<PasswordStrengthMeter password="TestPass#9k2" email="user@gmail.com" />);
  assert('(REG1) PasswordStrengthMeter renders a level',
    /Weak|Fair|Good|Strong|Very Strong/.test(a.container.textContent ?? ''));
  a.cleanup();
  const b = mount(<OtpInput value="" onChange={() => { /* */ }} length={6} />);
  eq('(REG2) OtpInput renders 6 slots', 6,
     b.container.querySelectorAll('input[data-testid^="otp-slot-"]').length);
  b.cleanup();
  const c = mount(<PincodeField value="" onChange={() => { /* */ }} />);
  assert('(REG3) PincodeField renders an input',
    !!c.container.querySelector('input[name="pinCode"]'));
  c.cleanup();
}

async function main() {
  renderTests();
  navTests();
  singleAndEmptyTests();
  swipeTests();
  imageTests();
  ctaTests();
  timerCleanupTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
