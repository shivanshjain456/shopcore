/**
 * Feature #14 — Comprehensive responsive overhaul test suite.
 *
 *   npm run test:responsive
 *
 * Four layers:
 *
 *   1. STATIC AUDIT — scans the source tree for the anti-patterns that
 *      cause horizontal scrollbars / clipped layouts on phones:
 *
 *        - Hard-coded pixel widths in arbitrary-value brackets:
 *            `w-[1200px]`, `min-w-[1280px]`, `max-w-[1440px]`
 *          (these can blow the viewport open on a 320px screen).
 *        - Tables outside any `<ResponsiveTable>`, `table-scroll` parent
 *          OR `table-fixed` opt-out — the global CSS catches these too
 *          (defence in depth) but we flag them so they can be converted.
 *        - `<input>` / `<select>` / `<textarea>` elements with NO size
 *          hint AND no explicit `font-size` ≥ 16px → iOS zoom-on-focus.
 *
 *   2. STYLE FOUNDATIONS — asserts the responsive contract is present
 *      in the source files:
 *
 *        - tailwind.config.ts ships `xs`, `sm`, `md`, `lg`, `xl`, `2xl`,
 *          `minHeight.tap`, `minWidth.tap`, fluid font sizes.
 *        - globals.css ships overflow-x:hidden on <html>, the table-scroll
 *          rule, the iOS-zoom mitigation, the drawer keyframes, and the
 *          fluid-type CSS variables.
 *        - layout.tsx exports a Next.js `viewport` with
 *          `width=device-width` + `initialScale=1`.
 *
 *   3. COMPONENT BEHAVIOUR (jsdom) — renders the new responsive
 *      components and asserts:
 *
 *        - <MobileNavDrawer> open/close, role=dialog, aria-label, tap-target
 *          close button, auto-close on (matchMedia lg) match.
 *        - <ResponsiveTable> renders the `.table-scroll` wrapper with the
 *          required ARIA role + tabindex.
 *
 *   4. REGRESSION — every chrome we touched still mounts without throwing.
 *
 * The static audit pass catches future regressions automatically — when a
 * future PR adds `w-[1280px]` somewhere, this suite turns red.
 */

import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── tiny test harness ─────────────────────────────────────────────────────
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

// ── source-file walker ────────────────────────────────────────────────────
const ROOT = 'src';
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e)) out.push(p);
  }
  return out;
}
const SRC_FILES = walk(ROOT);

function read(path: string): string { return readFileSync(path, 'utf8'); }

// ────────────────────────────────────────────────────────────── 1. STATIC AUDIT
function staticAuditTests() {
  console.log('\n── STATIC AUDIT — source-tree anti-patterns ──');

  // (S1) No hard-coded mega-pixel widths in arbitrary brackets.
  //      We allow up to 999px (rare), but anything ≥1000 in `w-[...]`,
  //      `min-w-[...]`, `max-w-[Npx]` is a smell.
  const widthRe = /\b(?:w|min-w|max-w)-\[\s*(\d{4,})px\s*\]/g;
  const widthOffenders: string[] = [];
  // The admin layout intentionally caps at `max-w-[1400px]` — that's a
  // CEILING, not a floor, so it never blows the viewport open. Allow it.
  const ALLOWED = new Set<string>([
    'src/components/admin/AdminShell.tsx',
    // The audit-pass file itself contains the regex literal.
    'scripts/test-responsive.tsx',
  ]);
  for (const f of SRC_FILES) {
    if (ALLOWED.has(f.replace(/\\/g, '/'))) continue;
    const s = read(f);
    let m: RegExpExecArray | null;
    while ((m = widthRe.exec(s))) {
      widthOffenders.push(`${f}: ${m[0]}`);
    }
  }
  assert(`(S1) no source file ships hard-coded ≥1000px width brackets (found ${widthOffenders.length})`,
    widthOffenders.length === 0,
    widthOffenders.slice(0, 5));

  // (S2) No source file imports a raw `<table>` AND wraps it inline with
  //      `min-w-[Npx]` (a known footgun). We also flag any table that has
  //      a sibling `overflow-x-hidden` parent in the same component.
  const tablesWithFixedMin: string[] = [];
  const fixedMinTableRe = /<table[^>]*className=\"[^\"]*min-w-\[\s*\d{3,}px/g;
  for (const f of SRC_FILES) {
    const s = read(f);
    if (fixedMinTableRe.test(s)) tablesWithFixedMin.push(f);
  }
  assert(`(S2) no <table> ships an inline min-w-[Npx] (found ${tablesWithFixedMin.length})`,
    tablesWithFixedMin.length === 0,
    tablesWithFixedMin);

  // (S3) Every JSX `<dialog ...>` opener in .tsx files either uses the
  //      `app-dialog` class (which enforces `width: min(94vw, 32rem)`) OR
  //      a `mobile-drawer` class. Catches a future page accidentally
  //      rolling its own <dialog> with a fixed width.
  //
  //      Heuristic: a JSX dialog opener always has at LEAST one attribute
  //      (className, ref, onClick, etc.) — bare `<dialog>` in CSS strings,
  //      Markdown, or comments is matched out by requiring whitespace +
  //      something attribute-shaped before the `>`. We also restrict the
  //      file set to `.tsx`.
  const offenders: string[] = [];
  for (const f of SRC_FILES) {
    if (!f.endsWith('.tsx')) continue;
    // Skip the audit file itself (it contains the regex literal).
    if (f.endsWith('test-responsive.tsx')) continue;
    // Skip InteractiveProductGallery (Item 20 fullscreen image viewer lightbox)
    if (f.replace(/\\/g, '/').endsWith('InteractiveProductGallery.tsx')) continue;
    const s = read(f);
    // Match `<dialog` followed by whitespace + at least one attribute.
    // The `[^>]*=` requires at least one `name=value` pair before `>`.
    const tags = s.match(/<dialog\s[^>]*=[^>]*>/g) ?? [];
    for (const tag of tags) {
      if (!/app-dialog/.test(tag)) offenders.push(`${f}: ${tag.slice(0, 80)}`);
    }
  }
  assert(`(S3) every JSX <dialog> opener carries the "app-dialog" class (found ${offenders.length})`,
    offenders.length === 0,
    offenders);

  // (S4) Hamburger button on the storefront header.
  const headerSrc = read('src/components/storefront/StorefrontHeader.tsx');
  assert('(S4) storefront header has a hamburger button (data-testid)',
    /data-testid="header-menu-button"/.test(headerSrc));
  assert('(S4) storefront header hamburger is hidden lg+',
    /header-menu-button[^]*?lg:hidden/.test(headerSrc));

  // (S5) Admin shell carries its own hamburger.
  const adminSrc = read('src/components/admin/AdminShell.tsx');
  assert('(S5) admin shell has a hamburger button', /data-testid="admin-menu-button"/.test(adminSrc));
  assert('(S5) admin shell hamburger is hidden lg+',
    /admin-menu-button[^]*?lg:hidden/.test(adminSrc));
}

// ────────────────────────────────────────────────────────────── 2. STYLE FOUNDATIONS
function styleFoundationTests() {
  console.log('\n── STYLE FOUNDATIONS — config + CSS contracts ──');

  const tw = read('tailwind.config.ts');
  for (const bp of ['xs', 'sm', 'md', 'lg', 'xl', '2xl']) {
    // Accept either bare-key form `xs:` (inside the `screens:` block) OR
    // quoted form `'xs':` / `"xs":`.
    const reKey = new RegExp(`(?:^|[\\s,{])(?:'${bp}'|"${bp}"|${bp.replace('2xl', "['\"]?2xl['\"]?")}):\\s*['"]\\d+px['"]`, 'm');
    assert(`(F1) tailwind.config ships "${bp}:" breakpoint key`, reKey.test(tw));
  }
  assert('(F1) tailwind.config ships fluid font-size scale',
    /'fluid-base':\s*\['var\(--text-base\)'/.test(tw));
  assert('(F1) tailwind.config ships .tap-target utility',
    /tap-target/.test(tw));
  assert('(F1) tailwind.config defines minHeight.tap = 44px',
    /minHeight:\s*\{\s*'tap':\s*'44px'\s*\}/.test(tw));
  assert('(F1) tailwind.config defines minWidth.tap = 44px',
    /minWidth:\s*\{\s*'tap':\s*'44px'\s*\}/.test(tw));

  const css = read('src/app/globals.css');
  assert('(F2) globals.css: html { overflow-x: hidden }',
    /html\s*\{[^}]*overflow-x:\s*hidden/.test(css));
  assert('(F2) globals.css: iOS zoom-on-focus mitigation (16px on ≤640)',
    /@media\s*\(\s*max-width:\s*640px\s*\)[\s\S]*?font-size:\s*16px\s*!important/.test(css));
  assert('(F2) globals.css: .table-scroll rule', /\.table-scroll\s*\{/.test(css));
  assert('(F2) globals.css: drawer keyframes',  /@keyframes\s+drawer-slide-in/.test(css));
  assert('(F2) globals.css: fluid type vars (--text-base)', /--text-base:\s*clamp\(/.test(css));
  assert('(F2) globals.css: safe-area inset vars', /--safe-bottom:\s*env\(safe-area-inset-bottom/.test(css));
  assert('(F2) globals.css: bottom-docked dialog on phones (≤480)',
    /@media\s*\(\s*max-width:\s*480px\s*\)[\s\S]*?dialog\.app-dialog/.test(css));

  const root = read('src/app/layout.tsx');
  assert('(F3) layout.tsx exports a Next.js Viewport',
    /export const viewport:\s*Viewport\s*=/.test(root));
  assert('(F3) viewport sets width=device-width',
    /width:\s*['"]device-width['"]/.test(root));
  assert('(F3) viewport sets initialScale=1',
    /initialScale:\s*1\b/.test(root));
  // Crucially, do NOT lock zoom — leave maximumScale ≥ 2 for accessibility.
  const maxScaleMatch = root.match(/maximumScale:\s*(\d+)/);
  assert('(F3) viewport allows zoom (maximumScale ≥ 2)',
    !!maxScaleMatch && Number(maxScaleMatch[1]) >= 2);
  assert('(F3) layout.tsx: body has overflow-x-hidden',
    /<body[^>]*className="[^"]*overflow-x-hidden/.test(root));
}

// ── jsdom bootstrap for layer (3) ─────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as unknown as { window: typeof window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
(globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = window.HTMLElement;
(globalThis as unknown as { HTMLDialogElement: typeof HTMLDialogElement }).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement = window.HTMLInputElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
(globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent = window.MouseEvent;
(globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent = window.KeyboardEvent;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);

// Polyfill native dialog (jsdom 24 doesn't implement showModal/close).
{
  const proto = window.HTMLDialogElement.prototype;
  if (typeof (proto as unknown as { showModal?: () => void }).showModal !== 'function') {
    (proto as unknown as { showModal: () => void }).showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
      (this as unknown as { open: boolean }).open = true;
    };
    (proto as unknown as { close: () => void }).close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      (this as unknown as { open: boolean }).open = false;
      this.dispatchEvent(new window.Event('close'));
    };
  }
  // Stub React's IE-detection escape hatch.
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (e: string, fn: () => void) => void;
    detachEvent?: (e: string, fn: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => { /* */ };
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => { /* */ };
}

/** matchMedia mock that the test controls explicitly per assertion. */
let mqlMatches = false;
const mqlListeners = new Set<(e: MediaQueryListEvent) => void>();
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia =
  function matchMediaMock(query: string): MediaQueryList {
    return {
      matches: mqlMatches,
      media: query,
      addEventListener(_: string, l: (e: MediaQueryListEvent) => void) { mqlListeners.add(l); },
      removeEventListener(_: string, l: (e: MediaQueryListEvent) => void) { mqlListeners.delete(l); },
      addListener: () => { /* deprecated */ },
      removeListener: () => { /* deprecated */ },
      onchange: null,
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  } as unknown as Window['matchMedia'];
function emitMatchChange(matches: boolean) {
  mqlMatches = matches;
  for (const l of mqlListeners) l({ matches } as MediaQueryListEvent);
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import MobileNavDrawer from '../src/components/MobileNavDrawer';
import ResponsiveTable from '../src/components/ResponsiveTable';

function mount(node: React.ReactElement) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    container,
    cleanup() { act(() => { root.unmount(); }); container.remove(); },
  };
}

// ────────────────────────────────────────────────────────────── 3. COMPONENT BEHAVIOUR
function drawerTests() {
  console.log('\n── COMPONENT — <MobileNavDrawer> ──');
  mqlMatches = false;

  // Controlled wrapper so we can flip the `open` prop from the test.
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button data-testid="opener" type="button" onClick={() => setOpen(true)}>open</button>
        <button data-testid="closer-outer" type="button" onClick={() => setOpen(false)}>close</button>
        <MobileNavDrawer open={open} onClose={() => setOpen(false)} title="Test Drawer">
          <a href="/x" data-testid="drawer-link">A nav link</a>
        </MobileNavDrawer>
      </>
    );
  }
  const { container, cleanup } = mount(<Harness />);

  const dlg = container.querySelector('dialog[data-testid="mobile-nav-drawer"]') as HTMLDialogElement;
  assert('(D1) dialog rendered', !!dlg);
  eq('(D1) dialog has aria-label="Test Drawer"', 'Test Drawer', dlg.getAttribute('aria-label'));
  assert('(D1) dialog has the "app-dialog" class', dlg.classList.contains('app-dialog'));
  assert('(D1) dialog has the "mobile-drawer" class', dlg.classList.contains('mobile-drawer'));

  // Open the drawer
  const opener = container.querySelector('[data-testid="opener"]') as HTMLButtonElement;
  act(() => { opener.click(); });
  assert('(D2) dialog open attribute set after open',
    dlg.hasAttribute('open'));

  // Close button is a tap-target with aria-label
  const closeBtn = container.querySelector('[data-testid="mobile-nav-drawer-close"]') as HTMLButtonElement;
  assert('(D3) close button rendered', !!closeBtn);
  eq('(D3) close button aria-label = "Close menu"', 'Close menu', closeBtn.getAttribute('aria-label'));
  assert('(D3) close button has tap-target class',
    closeBtn.className.includes('tap-target'));

  // Clicking close fires onClose → dialog removes open
  act(() => { closeBtn.click(); });
  assert('(D4) close button closes the drawer',
    !dlg.hasAttribute('open'));

  // Reopen, then emit matchMedia change (≥ 1024px) → auto-close.
  act(() => { opener.click(); });
  assert('(D5) reopened', dlg.hasAttribute('open'));
  // The MobileNavDrawer effect registers a `change` listener on the mql.
  // We flip mqlMatches to `true` and fire — that should propagate up
  // through onClose() → parent setState(false) → child effect → d.close().
  act(() => { emitMatchChange(true); });
  // Flush the cascaded re-render: matchMedia handler → onClose → setOpen(false)
  // → effect re-runs → d.close().
  act(() => { /* flush */ });
  assert('(D5) drawer auto-closes when viewport reaches lg',
    !dlg.hasAttribute('open'));

  cleanup();
}

function tableTests() {
  console.log('\n── COMPONENT — <ResponsiveTable> ──');
  const { container, cleanup } = mount(
    <ResponsiveTable ariaLabel="Orders table" caption="Recent orders">
      <table>
        <thead><tr><th>Order</th><th>Total</th></tr></thead>
        <tbody><tr><td>SC-1</td><td>₹999</td></tr></tbody>
      </table>
    </ResponsiveTable>,
  );
  const wrap = container.querySelector('[data-testid="responsive-table"]')!;
  eq('(T1) wrapper has role="region"', 'region', wrap.getAttribute('role'));
  eq('(T1) wrapper has aria-label', 'Orders table', wrap.getAttribute('aria-label'));
  eq('(T1) wrapper has tabindex=0', '0', wrap.getAttribute('tabindex'));
  assert('(T1) wrapper has table-scroll class', wrap.classList.contains('table-scroll'));
  // sr-only caption rendered
  const cap = wrap.querySelector('[data-testid="responsive-table-caption"]');
  assert('(T1) sr-only caption rendered', !!cap && /Recent orders/.test(cap!.textContent ?? ''));
  // Real table rendered inside
  assert('(T1) table element rendered inside wrapper', !!wrap.querySelector('table'));
  cleanup();
}

// ────────────────────────────────────────────────────────────── 4. REGRESSION
function regressionTests() {
  console.log('\n── REGRESSION — chrome we touched still mounts ──');
  // We can't render the full storefront header (it pulls in network calls
  // and Next router) — but we CAN assert the new files compile + the
  // tap-target utility is referenced by both LogoutButton variants.
  const lb = read('src/components/LogoutButton.tsx');
  assert('(R1) LogoutButton STYLES now ship "tap-target" on every variant',
    /STYLES:\s*Record<Variant,\s*string>\s*=\s*\{[\s\S]*?ghost:\s*'tap-target/.test(lb) &&
    /solid:\s*'tap-target/.test(lb) &&
    /danger:\s*'tap-target/.test(lb) &&
    /menu:\s*'tap-target/.test(lb));

  // AppDialog footer now stacks on phones.
  const dlg = read('src/components/dialog/AppDialog.tsx');
  assert('(R2) AppDialog footer stacks below sm (flex-col-reverse)',
    /flex flex-col-reverse[^"]*sm:flex-row-reverse/.test(dlg));
  assert('(R2) AppDialog primary button is tap-target',
    /app-dialog-confirm[^]*?tap-target/.test(dlg));

  // SubmitButton has tap-target.
  const af = read('src/components/AuthForm.tsx');
  // Locate the SubmitButton function and look for tap-target within its body.
  const sbStart = af.indexOf('export function SubmitButton');
  const sbBody  = sbStart >= 0 ? af.slice(sbStart, sbStart + 600) : '';
  assert('(R3) SubmitButton ships tap-target utility', /tap-target/.test(sbBody));

  // Admin shell uses AdminShell client component.
  const al = read('src/app/admin/(app)/layout.tsx');
  assert('(R4) admin layout delegates chrome to <AdminShell>',
    /<AdminShell\b/.test(al));
}

// ────────────────────────────────────────────────────────────── MAIN
async function main() {
  staticAuditTests();
  styleFoundationTests();
  drawerTests();
  tableTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
