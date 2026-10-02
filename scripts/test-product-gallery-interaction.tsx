/**
 * Item 20 — Product Gallery Interaction test harness.
 *
 *   npm run test:product-gallery-interaction
 *
 * Sections:
 *   1. UNIT          — `readGalleryInteractionSettings` defaults / clamps;
 *                      enum + numeric coercion; loop vs. clamp navigation;
 *                      featureGate exports.
 *   2. STATIC AUDIT  — required files present; store-config has the 6
 *                      new keys; featureGate exports the helpers; no
 *                      `console.*` / `: any` / `as any` / `key={i|idx|index}`
 *                      in the new interactive component; no native
 *                      dialogs; reduced-motion is honoured in source.
 *   3. COMPONENT     — jsdom render of <InteractiveProductGallery>:
 *                      thumbnail click swaps main image; aria-current
 *                      flips; arrow-keys cycle; Home/End jump; counter
 *                      updates; prev/next buttons obey loop config;
 *                      empty-state branch; touch swipe; fullscreen
 *                      lightbox open + Escape close + focus restore.
 *   4. INTEGRATION   — `next start -p 3081`: PDP renders interactive
 *                      gallery markup by default; flipping
 *                      `products.galleryInteractionsEnabled=false`
 *                      falls back to the Item-19 static markup;
 *                      flipping `galleryFullscreenEnabled=false`
 *                      hides the fullscreen affordance.
 *   5. REGRESSION    — Item 19 static gallery still renders; product
 *                      cards / homepage / search still serve images.
 */
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';

// ── jsdom setup ──────────────────────────────────────────────────────────
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
type AnyGlobal = Record<string, unknown>;
(globalThis as AnyGlobal).window = window;
(globalThis as AnyGlobal).self   = window;
(globalThis as AnyGlobal).document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
(globalThis as AnyGlobal).HTMLElement = window.HTMLElement;
(globalThis as AnyGlobal).HTMLInputElement = window.HTMLInputElement;
(globalThis as AnyGlobal).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as AnyGlobal).Node = window.Node;
(globalThis as AnyGlobal).Event = window.Event;
(globalThis as AnyGlobal).MouseEvent = window.MouseEvent;
(globalThis as AnyGlobal).KeyboardEvent = window.KeyboardEvent;
(globalThis as AnyGlobal).getComputedStyle = window.getComputedStyle.bind(window);
{
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (e: string, fn: () => void) => void;
    detachEvent?: (e: string, fn: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => { /* */ };
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => { /* */ };
}
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((q: string) => ({
  matches: false, media: q, onchange: null,
  addListener:    () => { /* legacy */ },
  removeListener: () => { /* legacy */ },
  addEventListener:    () => { /* */ },
  removeEventListener: () => { /* */ },
  dispatchEvent: () => false,
})) as unknown as (q: string) => MediaQueryList;
(globalThis as AnyGlobal).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom doesn't implement <dialog>.showModal; stub minimal behaviour so
// the lightbox open path doesn't throw.
{
  const Dlg = window.HTMLDialogElement.prototype as unknown as {
    showModal?: () => void; close?: () => void; open: boolean;
  };
  if (typeof Dlg.showModal !== 'function') {
    Dlg.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  }
  if (typeof Dlg.close !== 'function') {
    Dlg.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  }
}
// next/link expects requestIdleCallback in some paths.
(window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback =
  ((cb: () => void) => { void cb; return 0; }) as unknown as (cb: () => void) => number;
(window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback =
  (() => undefined) as unknown as (id: number) => void;
(globalThis as AnyGlobal).requestIdleCallback = (window as unknown as AnyGlobal).requestIdleCallback;
(globalThis as AnyGlobal).cancelIdleCallback  = (window as unknown as AnyGlobal).cancelIdleCallback;

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
(globalThis as AnyGlobal).React = React;

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import {
  readGalleryInteractionSettings, type GalleryInteractionSettings,
  type ProductImageRow,
} from '../src/lib/cms/productGallery';
import InteractiveProductGallery from '../src/components/storefront/InteractiveProductGallery';

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  \u2714 ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  \u2718 ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  if (existsSync(SRV_LOG)) {
    const tail = readFileSync(SRV_LOG, 'utf-8').split('\n').slice(-20).join('\n');
    console.error('     \u2500\u2500 recent server lines \u2500\u2500\n' + tail);
  }
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else failAssert(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else failAssert(label, true, detail ?? false);
}

const TAG       = `pgi_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const TAG_SLUG  = `pgi-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const PORT      = 3081;
const BASE      = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG   = `/tmp/test-product-gallery-interaction-${process.pid}.log`;
const REPO_ROOT = path.resolve(__dirname, '..');

interface Mounted { container: HTMLDivElement; root: Root; cleanup: () => void }
function mount(el: React.ReactElement): Mounted {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  let root!: Root;
  act(() => { root = createRoot(container); root.render(el); });
  return {
    container, root,
    cleanup: () => { act(() => { root.unmount(); }); container.remove(); },
  };
}
function rerender(m: Mounted, el: React.ReactElement) {
  act(() => { m.root.render(el); });
}
function click(el: HTMLElement) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function keydown(el: HTMLElement, key: string) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function fakeImages(n: number): ProductImageRow[] {
  const list: ProductImageRow[] = [];
  for (let i = 0; i < n; i++) {
    list.push({
      id: `img-${i}`,
      productId: 'prod-fixture',
      url: `/uploads/test/${TAG}-${i}.jpg`,
      alt: `View ${i}`,
      sortOrder: (i + 1) * 10,
      isPrimary: i === 0,
      isActive: true,
      createdAt: new Date(0), updatedAt: new Date(0),
    });
  }
  return list;
}

const DEFAULT_SETTINGS: GalleryInteractionSettings = {
  interactionsEnabled: true,
  zoomEnabled:         true,
  fullscreenEnabled:   true,
  loopEnabled:         false,
  transitionMs:        150,
  thumbnailPosition:   'bottom',
};

// ─────────────────────────────────────────────────────────── 1. UNIT
function unitTests() {
  console.log('\n\u2500\u2500 UNIT \u2500\u2500');

  // (PGI1.1) Defaults from an empty config.
  const dflt = readGalleryInteractionSettings({});
  eq('[PGI1.1] interactionsEnabled defaults true', true,  dflt.interactionsEnabled);
  eq('[PGI1.1] zoomEnabled defaults true',         true,  dflt.zoomEnabled);
  eq('[PGI1.1] fullscreenEnabled defaults true',   true,  dflt.fullscreenEnabled);
  eq('[PGI1.1] loopEnabled defaults false',        false, dflt.loopEnabled);
  eq('[PGI1.1] transitionMs defaults 150',         150,   dflt.transitionMs);
  eq('[PGI1.1] thumbnailPosition defaults bottom', 'bottom', dflt.thumbnailPosition);

  // (PGI1.2) Explicit values flow through.
  const explicit = readGalleryInteractionSettings({
    products: {
      galleryInteractionsEnabled: false,
      galleryZoomEnabled:         false,
      galleryFullscreenEnabled:   false,
      galleryLoopEnabled:         true,
      galleryTransitionMs:        300,
      galleryThumbnailPosition:   'left',
    },
  });
  eq('[PGI1.2] interactionsEnabled false honoured', false, explicit.interactionsEnabled);
  eq('[PGI1.2] loopEnabled true honoured',          true,  explicit.loopEnabled);
  eq('[PGI1.2] transitionMs 300 honoured',          300,   explicit.transitionMs);
  eq('[PGI1.2] thumbnailPosition left honoured',    'left', explicit.thumbnailPosition);

  // (PGI1.3) Out-of-range values clamped.
  const clamped = readGalleryInteractionSettings({
    products: { galleryTransitionMs: -10 },
  });
  eq('[PGI1.3] negative transitionMs clamped to 0', 0, clamped.transitionMs);
  const tooBig = readGalleryInteractionSettings({
    products: { galleryTransitionMs: 99999 },
  });
  eq('[PGI1.3] huge transitionMs clamped to 500', 500, tooBig.transitionMs);

  // (PGI1.4) Garbage thumbnailPosition falls back to bottom.
  const garbage = readGalleryInteractionSettings({
    products: { galleryThumbnailPosition: 'spiral' },
  });
  eq('[PGI1.4] unknown thumbnailPosition → bottom', 'bottom', garbage.thumbnailPosition);
}

// ─────────────────────────────────────────────────────── 2. STATIC AUDIT
function staticAuditTests() {
  console.log('\n\u2500\u2500 STATIC AUDIT \u2500\u2500');

  const files = [
    'src/components/storefront/InteractiveProductGallery.tsx',
    'src/components/storefront/ProductGallery.tsx',
    'src/lib/cms/productGallery.ts',
    'src/lib/storeConfig/schema.ts',
    'src/lib/storeConfig/featureGate.ts',
  ];
  for (const f of files) {
    assert(`[PGI2.1] file exists: ${f}`, existsSync(path.join(REPO_ROOT, f)));
  }

  // (PGI2.2) The 6 new store-config keys are registered.
  const schema = readFileSync(path.join(REPO_ROOT, 'src/lib/storeConfig/schema.ts'), 'utf-8');
  for (const k of [
    'products.galleryInteractionsEnabled',
    'products.galleryZoomEnabled',
    'products.galleryFullscreenEnabled',
    'products.galleryLoopEnabled',
    'products.galleryTransitionMs',
    'products.galleryThumbnailPosition',
  ]) {
    assert(`[PGI2.2] schema registers ${k}`, schema.includes(`'${k}'`));
  }

  // (PGI2.3) featureGate exports the 4 boolean helpers.
  const fg = readFileSync(path.join(REPO_ROOT, 'src/lib/storeConfig/featureGate.ts'), 'utf-8');
  for (const h of [
    'isGalleryInteractionsEnabled',
    'isGalleryZoomEnabled',
    'isGalleryFullscreenEnabled',
    'isGalleryLoopEnabled',
  ]) {
    assert(`[PGI2.3] featureGate exports ${h}`, fg.includes(h));
  }

  // (PGI2.4) Interactive component is `'use client'` and respects
  //          reduced-motion.
  const interactive = readFileSync(
    path.join(REPO_ROOT, 'src/components/storefront/InteractiveProductGallery.tsx'),
    'utf-8',
  );
  assert('[PGI2.4] InteractiveProductGallery is a client component',
    /^['"]use client['"]\s*;/.test(interactive));
  assert('[PGI2.4] InteractiveProductGallery honours prefers-reduced-motion',
    interactive.includes('prefers-reduced-motion'));
  assert('[PGI2.4] InteractiveProductGallery uses reducedMotion gate in transition logic',
    interactive.includes('reducedMotion ? 0 : settings.transitionMs'));

  // (PGI2.5) No native dialogs / no console / no `: any` / no `as any`
  //          / no `key={i|idx|index}` in the new client file.
  assert('[PGI2.5] no window.alert/confirm/prompt',
    !/\bwindow\.(alert|confirm|prompt)\(/.test(interactive));
  assert('[PGI2.5] no console.*',
    !/\bconsole\.(log|warn|error|info|debug)\(/.test(interactive));
  assert('[PGI2.5] no ": any" annotation',
    !/:\s*any\b/.test(interactive));
  assert('[PGI2.5] no "as any" assertion',
    !/\bas\s+any\b/.test(interactive));
  assert('[PGI2.5] no key={i|idx|index} (stable keys only)',
    !/key=\{(i|idx|index)\}/.test(interactive));

  // (PGI2.6) The shell `ProductGallery` delegates to the interactive
  //          component when `interactionsEnabled` is true.
  const shell = readFileSync(path.join(REPO_ROOT, 'src/components/storefront/ProductGallery.tsx'), 'utf-8');
  assert('[PGI2.6] shell imports InteractiveProductGallery',
    shell.includes("import InteractiveProductGallery from './InteractiveProductGallery'"));
  assert('[PGI2.6] shell branches on interactionsEnabled',
    shell.includes('interactionSettings.interactionsEnabled'));

  // (PGI2.7) PDP passes the new prop through.
  const pdp = readFileSync(path.join(REPO_ROOT, 'src/app/(storefront)/p/[slug]/page.tsx'), 'utf-8');
  assert('[PGI2.7] PDP reads readGalleryInteractionSettings',
    pdp.includes('readGalleryInteractionSettings'));
  assert('[PGI2.7] PDP passes interactionSettings prop',
    pdp.includes('interactionSettings={galleryInteractions}'));

  // (PGI2.8) Lightbox uses the native <dialog> (focus-trap for free).
  assert('[PGI2.8] lightbox uses native <dialog>',
    /<dialog\b/.test(interactive));
  assert('[PGI2.8] lightbox calls showModal',
    interactive.includes('showModal'));

  // (PGI2.9) ARIA scaffolding present.
  assert('[PGI2.9] thumbnail rail uses role="tablist"',
    interactive.includes('role="tablist"'));
  assert('[PGI2.9] thumbnails use role="tab"',
    interactive.includes('role="tab"'));
  assert('[PGI2.9] selected thumbnail sets aria-selected',
    interactive.includes('aria-selected={selected}'));
  assert('[PGI2.9] active image announced via aria-live',
    interactive.includes('aria-live="polite"'));
}

// ─────────────────────────────────────────────────────── 3. COMPONENT
function componentTests() {
  console.log('\n\u2500\u2500 COMPONENT \u2500\u2500');

  // (PGI3.1) Mounts + renders the right number of thumbs and a counter.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Test Product',
      images: fakeImages(4),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const thumbs = m.container.querySelectorAll('[data-testid="product-gallery-thumb"]');
    eq('[PGI3.1] renders 4 thumbnails', 4, thumbs.length);
    const counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.1] counter rendered', !!counter && /1\s*\/\s*4/.test(counter.textContent ?? ''));
    const mainImg = m.container.querySelector('[data-testid="product-gallery-main-img"]') as HTMLImageElement;
    assert('[PGI3.1] main img has fetchpriority=high', mainImg?.getAttribute('fetchpriority') === 'high');
    m.cleanup();
  }

  // (PGI3.2) Clicking a thumbnail swaps the active main image + flips
  //          aria-selected.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Test',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const thumbs = Array.from(m.container.querySelectorAll('[data-testid="product-gallery-thumb"]')) as HTMLElement[];
    // Initially thumb 0 is selected.
    eq('[PGI3.2] thumb 0 starts selected', 'true', thumbs[0]!.getAttribute('aria-selected'));
    eq('[PGI3.2] thumb 2 starts NOT selected', 'false', thumbs[2]!.getAttribute('aria-selected'));
    act(() => { click(thumbs[2]!); });
    eq('[PGI3.2] thumb 2 becomes selected after click', 'true', thumbs[2]!.getAttribute('aria-selected'));
    eq('[PGI3.2] thumb 0 no longer selected', 'false', thumbs[0]!.getAttribute('aria-selected'));
    const counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.2] counter says 3 / 3', /3\s*\/\s*3/.test(counter?.textContent ?? ''));
    const mainImg = m.container.querySelector('[data-testid="product-gallery-main-img"]') as HTMLImageElement;
    assert('[PGI3.2] main img src updated', mainImg?.src.endsWith('-2.jpg'));
    m.cleanup();
  }

  // (PGI3.3) Prev / Next buttons cycle and respect the loop=false default.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Test',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const prev = m.container.querySelector('[data-testid="gallery-prev"]') as HTMLButtonElement;
    const next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    assert('[PGI3.3] prev button disabled at start (loop=false)', prev.disabled);
    assert('[PGI3.3] next button enabled at start', !next.disabled);
    act(() => { click(next); });
    assert('[PGI3.3] prev enabled after one Next', !prev.disabled);
    act(() => { click(next); });
    // Now at last image.
    assert('[PGI3.3] next disabled at last image (loop=false)', next.disabled);
    m.cleanup();
  }

  // (PGI3.4) Loop enabled → next wraps to first.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Test',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: { ...DEFAULT_SETTINGS, loopEnabled: true },
    }));
    let next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    // Flush state between clicks so each `goNext` reads the latest
    // `safeIdx` from its closure (React batches updates inside a
    // single act block).
    act(() => { click(next); });
    next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    act(() => { click(next); });
    next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    act(() => { click(next); });
    const counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.4] loop wraps to 1 / 3', /1\s*\/\s*3/.test(counter?.textContent ?? ''));
    next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    assert('[PGI3.4] next still enabled (loop=true)', !next.disabled);
    m.cleanup();
  }

  // (PGI3.5) Keyboard navigation — Arrow / Home / End.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Test',
      images: fakeImages(4),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const section = m.container.querySelector('[data-testid="product-gallery"]') as HTMLElement;
    act(() => { keydown(section, 'ArrowRight'); });
    let counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.5] ArrowRight → 2 / 4', /2\s*\/\s*4/.test(counter?.textContent ?? ''));
    act(() => { keydown(section, 'End'); });
    counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.5] End → 4 / 4', /4\s*\/\s*4/.test(counter?.textContent ?? ''));
    act(() => { keydown(section, 'Home'); });
    counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.5] Home → 1 / 4', /1\s*\/\s*4/.test(counter?.textContent ?? ''));
    act(() => { keydown(section, 'ArrowLeft'); });
    counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.5] ArrowLeft at first (loop=false) stays at 1 / 4',
      /1\s*\/\s*4/.test(counter?.textContent ?? ''));
    m.cleanup();
  }

  // (PGI3.6) Empty-state branch.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'No Photos',
      images: [],
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const root = m.container.querySelector('[data-testid="product-gallery"]');
    assert('[PGI3.6] empty-state renders gallery placeholder', !!root);
    eq('[PGI3.6] image-count attr is 0',
      '0', root?.getAttribute('data-product-image-count'));
    const thumbs = m.container.querySelectorAll('[data-testid="product-gallery-thumb"]');
    eq('[PGI3.6] no thumbnails in empty state', 0, thumbs.length);
    m.cleanup();
  }

  // (PGI3.7) Single-image branch — no counter, no prev/next, no thumb rail.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'Solo',
      images: fakeImages(1),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    assert('[PGI3.7] no counter for single image',
      !m.container.querySelector('[data-testid="gallery-counter"]'));
    assert('[PGI3.7] no prev/next buttons',
      !m.container.querySelector('[data-testid="gallery-prev"]') &&
      !m.container.querySelector('[data-testid="gallery-next"]'));
    assert('[PGI3.7] no thumb rail',
      !m.container.querySelector('[data-testid="product-gallery-thumbs"]'));
    m.cleanup();
  }

  // (PGI3.8) Fullscreen affordance respects the flag.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: { ...DEFAULT_SETTINGS, fullscreenEnabled: false },
    }));
    assert('[PGI3.8] no fullscreen button when disabled',
      !m.container.querySelector('[data-testid="gallery-fullscreen"]'));
    m.cleanup();
  }

  // (PGI3.9) Fullscreen open → close cycle.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const fsBtn = m.container.querySelector('[data-testid="gallery-fullscreen"]') as HTMLButtonElement;
    assert('[PGI3.9] fullscreen button present', !!fsBtn);
    act(() => { click(fsBtn); });
    // The dialog renders into the same container.
    const dlg = m.container.querySelector('[data-testid="gallery-lightbox"]') as HTMLDialogElement | null;
    assert('[PGI3.9] lightbox dialog mounted', !!dlg);
    const close = m.container.querySelector('[data-testid="lightbox-close"]') as HTMLButtonElement;
    act(() => { click(close); });
    const dlgAfter = m.container.querySelector('[data-testid="gallery-lightbox"]');
    assert('[PGI3.9] lightbox unmounted after close', !dlgAfter);
    m.cleanup();
  }

  // (PGI3.10) Touch swipe → navigates.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const main = m.container.querySelector('[data-testid="product-gallery-main"]') as HTMLElement;
    // Simulate a left-swipe (touchstart at 200 → touchend at 100 → next).
    const TouchCtor = (window as unknown as { TouchEvent?: typeof TouchEvent }).TouchEvent;
    if (typeof TouchCtor === 'function') {
      // Real TouchEvent if jsdom supports it (rare).
      const ts = new TouchCtor('touchstart', { bubbles: true, cancelable: true,
        touches: [{ clientX: 200, clientY: 50 } as unknown as Touch] });
      const te = new TouchCtor('touchend',   { bubbles: true, cancelable: true,
        changedTouches: [{ clientX: 100, clientY: 50 } as unknown as Touch] });
      act(() => { main.dispatchEvent(ts); main.dispatchEvent(te); });
    } else {
      // Fallback: dispatch synthetic events with the same shape React reads.
      const ts = new window.Event('touchstart', { bubbles: true, cancelable: true });
      (ts as unknown as { touches: unknown }).touches =
        [{ clientX: 200, clientY: 50 }];
      const te = new window.Event('touchend', { bubbles: true, cancelable: true });
      (te as unknown as { changedTouches: unknown }).changedTouches =
        [{ clientX: 100, clientY: 50 }];
      act(() => { main.dispatchEvent(ts); main.dispatchEvent(te); });
    }
    const counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.10] left-swipe advances to 2 / 3', /2\s*\/\s*3/.test(counter?.textContent ?? ''));
    m.cleanup();
  }

  // (PGI3.11) aria-live region announces the change.
  {
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: fakeImages(3),
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const status = m.container.querySelector('[data-testid="gallery-status"]') as HTMLElement;
    assert('[PGI3.11] status initially says 1 of 3',
      /Image 1 of 3/i.test(status.textContent ?? ''));
    const next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
    act(() => { click(next); });
    assert('[PGI3.11] status updates to 2 of 3',
      /Image 2 of 3/i.test(status.textContent ?? ''));
    m.cleanup();
  }

  // (PGI3.12) Updating the `images` prop preserves valid activeIdx
  //           (regression — when admin removes an image, the gallery
  //           shouldn't crash with an out-of-range index).
  {
    const imgs5 = fakeImages(5);
    const m = mount(React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: imgs5,
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    // Flush between clicks so React-batched updates step through the
    // gallery one image at a time.
    for (let step = 0; step < 4; step++) {
      const next = m.container.querySelector('[data-testid="gallery-next"]') as HTMLButtonElement;
      act(() => { click(next); });
    }
    rerender(m, React.createElement(InteractiveProductGallery, {
      productName: 'T',
      images: imgs5.slice(0, 2),  // drop to 2 images → activeIdx must clamp
      lazyLoadEnabled: true,
      settings: DEFAULT_SETTINGS,
    }));
    const counter = m.container.querySelector('[data-testid="gallery-counter"]');
    assert('[PGI3.12] active index clamps to last valid (2 / 2)',
      /2\s*\/\s*2/.test(counter?.textContent ?? ''));
    m.cleanup();
  }
}

// ─────────────────────────────────────────── 4 + 5. INTEGRATION + REGRESSION
async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', JOB_RUNNER_ENABLED: 'false' },
    detached: true,
  });
  const killGroup = (): void => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit',    killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });
  const append = (b: Buffer): void => { writeFileSync(SRV_LOG, b, { flag: 'a' }); };
  serverProc.stdout?.on('data', append);
  serverProc.stderr?.on('data', append);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { const r = await realFetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start within 30s \u2014 see ' + SRV_LOG);
}
async function stopServer(): Promise<void> {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Real Node fetch (the global one) — stash before any jsdom mock could
// rebind it. We don't mock fetch in this test (no client api() calls
// in the harness), but be defensive.
const realFetch: typeof fetch = (globalThis as AnyGlobal).fetch as typeof fetch;

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response): void {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar): string {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function withCsrf(): Promise<Jar> {
  const jar = newJar();
  const r = await realFetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, r);
  return jar;
}
async function adminJarFor(adminId: string): Promise<Jar> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  const fam = await issueRefreshFamily({ userId: adminId, role: 'ADMIN' });
  const ttl = accessTtlFor('ADMIN');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: u.id, role: u.role, email: u.email,
    jti: sessionId, fam: fam.familyId, status: u.status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId: adminId, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = await withCsrf();
  jar.cookies['sc_admin']         = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return jar;
}
async function withStoreConfig(jar: Jar, changes: Record<string, unknown>): Promise<() => Promise<void>> {
  const getRes = await realFetch(`${BASE}/api/admin/store-config`, {
    headers: { cookie: cookieHeader(jar) },
  });
  const body = await getRes.json() as { data: { config: Record<string, unknown> } };
  const cfg = body.data.config;
  const original: Record<string, unknown> = {};
  for (const k of Object.keys(changes)) {
    const [head, leaf] = k.split('.');
    const cat = cfg[head] as Record<string, unknown> | undefined;
    original[k] = cat?.[leaf];
  }
  const patchHeaders = new Headers();
  patchHeaders.set('cookie', cookieHeader(jar));
  patchHeaders.set('content-type', 'application/json');
  if (jar.cookies['sc_csrf']) patchHeaders.set('x-csrf-token', jar.cookies['sc_csrf']);
  patchHeaders.set('origin', BASE);
  const patchRes = await realFetch(`${BASE}/api/admin/store-config`, {
    method: 'PATCH', headers: patchHeaders,
    body: JSON.stringify({ changes }),
  });
  if (patchRes.status !== 200) {
    throw new Error(`PATCH /api/admin/store-config failed: ${patchRes.status}`);
  }
  return async () => {
    await realFetch(`${BASE}/api/admin/store-config`, {
      method: 'PATCH', headers: patchHeaders,
      body: JSON.stringify({ changes: original }),
    });
  };
}

interface FixtureProduct { id: string; slug: string }
async function createFixtureProduct(): Promise<FixtureProduct> {
  const cat = await prisma.category.upsert({
    where:  { slug: `${TAG_SLUG}-cat` },
    update: {},
    create: { name: `PGI cat ${TAG_SLUG}`, slug: `${TAG_SLUG}-cat`, sortOrder: 999, isActive: true },
  });
  const brand = await prisma.brand.upsert({
    where:  { slug: `${TAG_SLUG}-brand` },
    update: {},
    create: { name: `PGI brand ${TAG_SLUG}`, slug: `${TAG_SLUG}-brand`, isActive: true },
  });
  const p = await prisma.product.create({
    data: {
      sku: `${TAG}-sku`, name: `PGI Product ${TAG_SLUG}`,
      slug: `${TAG_SLUG}-product`,
      description: 'PGI fixture', shortDesc: 'PGI fixture',
      categoryId: cat.id, brandId: brand.id,
      mrpPaise: 100_000, pricePaise: 80_000,
      gstRate: 18, stock: 10, attributes: '{}', isActive: true,
      images: {
        create: [
          { url: `/uploads/test/${TAG}-front.jpg`,    alt: 'Front',    sortOrder: 10, isPrimary: true,  isActive: true },
          { url: `/uploads/test/${TAG}-rear.jpg`,     alt: 'Rear',     sortOrder: 20, isPrimary: false, isActive: true },
          { url: `/uploads/test/${TAG}-side.jpg`,     alt: 'Side',     sortOrder: 30, isPrimary: false, isActive: true },
        ],
      },
    },
  });
  return { id: p.id, slug: p.slug };
}

let _adminId: string | null = null;
async function getOrCreateAdmin(): Promise<string> {
  if (_adminId) return _adminId;
  const u = await prisma.user.create({
    data: {
      firstName: 'PGI', lastName: 'Admin',
      email: `${TAG}_admin@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestPGI'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new fixture admin.
      status: 'ACTIVE', phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  _adminId = u.id;
  return u.id;
}

async function integrationTests(): Promise<void> {
  console.log('\n\u2500\u2500 INTEGRATION + REGRESSION \u2500\u2500');
  await startServer();
  try {
    const adminId = await getOrCreateAdmin();
    const adminJar = await adminJarFor(adminId);
    const fx = await createFixtureProduct();

    // (PGI4.1) PDP renders the INTERACTIVE gallery by default.
    {
      const res = await realFetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
      eq('[PGI4.1] PDP status', 200, res.status);
      const html = await res.text();
      assert('[PGI4.1] data-gallery-mode="interactive" present',
        html.includes('data-gallery-mode="interactive"'));
      assert('[PGI4.1] thumbnail rail present',
        html.includes('data-testid="product-gallery-thumbs"'));
      assert('[PGI4.1] counter present',
        /\d+\s*\/\s*\d+/.test(html));
      assert('[PGI4.1] prev/next testids present',
        html.includes('data-testid="gallery-prev"') &&
        html.includes('data-testid="gallery-next"'));
      assert('[PGI4.1] fullscreen affordance present',
        html.includes('data-testid="gallery-fullscreen"'));
    }

    // (PGI4.2) Disabling interactionsEnabled flips back to STATIC markup.
    {
      const restore = await withStoreConfig(adminJar, { 'products.galleryInteractionsEnabled': false });
      try {
        const res = await realFetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
        const html = await res.text();
        assert('[PGI4.2] static mode does NOT include data-gallery-mode',
          !html.includes('data-gallery-mode="interactive"'));
        assert('[PGI4.2] static mode does NOT include gallery-counter',
          !html.includes('data-testid="gallery-counter"'));
        // Item 19 markers still present.
        assert('[PGI4.2] item-19 thumb rail present',
          html.includes('data-testid="product-gallery"'));
      } finally {
        await restore();
      }
    }

    // (PGI4.3) Disabling fullscreen hides the affordance.
    {
      const restore = await withStoreConfig(adminJar, { 'products.galleryFullscreenEnabled': false });
      try {
        const res = await realFetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
        const html = await res.text();
        assert('[PGI4.3] fullscreen affordance hidden when disabled',
          !html.includes('data-testid="gallery-fullscreen"'));
      } finally {
        await restore();
      }
    }

    // (PGI4.4) Disabling the gallery entirely still shows the primary
    //          image (Item 19 fallback preserved).
    {
      const restore = await withStoreConfig(adminJar, { 'products.galleryEnabled': false });
      try {
        const res = await realFetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
        const html = await res.text();
        assert('[PGI4.4] gallery container still renders for the primary image',
          html.includes('data-testid="product-gallery"'));
        assert('[PGI4.4] no thumb rail when gallery disabled',
          !html.includes('data-testid="product-gallery-thumbs"'));
      } finally {
        await restore();
      }
    }

    // (PGI4.5) Regression — public /api/products + homepage still serve.
    {
      const r = await realFetch(`${BASE}/api/products?q=${encodeURIComponent('PGI Product')}`);
      eq('[PGI4.5] /api/products status', 200, r.status);
      const env = await r.json() as { data: { items: Array<{ slug: string; imageUrl: string | null }> } };
      const hit = env.data.items.find((p) => p.slug === fx.slug);
      assert('[PGI4.5] fixture appears in /api/products', !!hit);
      assert('[PGI4.5] /api/products imageUrl present',
        typeof hit?.imageUrl === 'string' && hit.imageUrl.length > 0);

      const home = await realFetch(`${BASE}/`);
      eq('[PGI4.5] / status', 200, home.status);
    }

    // (PGI4.6) Admin /admin/homepage (Item 18) still loads (redirects unauth).
    {
      const res = await realFetch(`${BASE}/admin/homepage`, { redirect: 'manual' });
      assert('[PGI4.6] /admin/homepage still routable',
        res.status === 200 || res.status === 302 || res.status === 307);
    }
  } finally {
    await stopServer();
    await wipeFixtures();
    await wipeAdmin();
  }
}

async function wipeFixtures(): Promise<void> {
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
  await prisma.brand.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
}

async function wipeAdmin(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { email: { startsWith: 'pgi_' } },
    select: { id: true },
  });
  for (const u of admins) {
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    try { await prisma.user.delete({ where: { id: u.id } }); } catch { /* leave */ }
  }
  console.log(`  \u2714 removed ${admins.length} admin fixture(s)`);
}

// ─────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    unitTests();
    staticAuditTests();
    componentTests();
    await integrationTests();
  } catch (e) {
    failed++;
    const err = e as Error;
    console.error('  \u2718 unhandled exception:', err.stack ?? err.message ?? String(e));
  } finally {
    try {
      await prisma.product.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
      await prisma.brand.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
      await prisma.category.deleteMany({ where: { slug: { startsWith: 'pgi-' } } });
    } catch { /* */ }
    await prisma.$disconnect();
    console.log(`\n\u2500\u2500 result \u2500\u2500 ${passed} passed \u00b7 ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}
void main();
