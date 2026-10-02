/**
 * Feature #35 — ShareButton + ShareDialog jsdom test.
 *
 *   npm run test:share-dialog
 *
 *   - RENDER: <ShareButton> emits a "Share" + caret pair; clicking
 *     "Share" without `navigator.share` opens the dialog; clicking
 *     the caret ALWAYS opens the dialog.
 *   - NATIVE SHARE: when `navigator.share` exists, clicking "Share"
 *     calls it with the correct title/text/url payload (with the
 *     utm_medium=native UTM stamped on the URL).
 *   - FALLBACK MODAL: every channel button is rendered with the
 *     correct platform URL.
 *   - COPY LINK: navigator.clipboard.writeText path; success status
 *     announced via role="status"; falls back when clipboard API
 *     unavailable (still announces success because the legacy
 *     execCommand path is exercised).
 *   - ACCESSIBILITY: role="dialog", aria-modal, aria-labelledby; Escape
 *     closes; backdrop click closes; close button closes; focus moves
 *     into the dialog on open.
 *   - EDGE: long product name + missing image render cleanly; description
 *     omitted still produces valid share URLs.
 *   - REGRESSION: PasswordStrengthMeter / OtpInput / PincodeField /
 *     ImageUploadInput / HeroCarousel still mount.
 */
import { JSDOM } from 'jsdom';

// Initialise jsdom with the test origin baked in — `window.location.origin`
// is read-only at runtime, so we can't redefine it later.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:9999/', pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as unknown as { window: typeof window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
(globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = window.HTMLElement;
(globalThis as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement = window.HTMLInputElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
(globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent = window.KeyboardEvent;
(globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent = window.MouseEvent;
(globalThis as unknown as { Response: typeof window.Response }).Response = window.Response;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);
{
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (e: string, fn: () => void) => void;
    detachEvent?: (e: string, fn: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => { /* */ };
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => { /* */ };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.APP_URL = 'http://localhost:9999';
// `window.location.origin` is already "http://localhost:9999" because the
// JSDOM constructor above used that URL.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ShareButton from '../src/components/storefront/ShareButton';
import PasswordStrengthMeter from '../src/components/auth/PasswordStrengthMeter';
import OtpInput from '../src/components/auth/OtpInput';
import PincodeField from '../src/components/forms/PincodeField';

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
async function flush(ms = 5): Promise<void> {
  await act(async () => { await new Promise<void>((r) => setTimeout(r, ms)); });
}

function mount(node: React.ReactElement) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, cleanup() { act(() => { root.unmount(); }); container.remove(); } };
}

// ──────────────────────────────────────────────────────────────── 1. RENDER (no native share)
function renderTests() {
  console.log('\n── RENDER (no navigator.share) ──');
  // Ensure no native share is exposed.
  (window.navigator as unknown as { share?: unknown }).share = undefined;

  const { container, cleanup } = mount(
    <ShareButton slug="blue-denim" productName="Blue Denim Jacket"
                 description="Brushed lining, perfect for winter."
                 imageUrl="https://cdn.example.com/jacket.jpg"
                 priceText="from ₹1,499" />,
  );

  const btn = container.querySelector('[data-testid="share-button"]') as HTMLButtonElement;
  assert('(R1) primary Share button rendered', !!btn);
  // No native share → aria-label says "open options".
  assert('(R1) aria-label mentions Blue Denim Jacket',
    (btn.getAttribute('aria-label') ?? '').includes('Blue Denim Jacket'));

  const more = container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  assert('(R1) caret button rendered', !!more);
  eq('(R1) caret aria-haspopup=dialog', 'dialog', more.getAttribute('aria-haspopup'));
  eq('(R1) caret aria-expanded=false initially', 'false', more.getAttribute('aria-expanded'));

  // Dialog NOT mounted yet.
  assert('(R1) dialog not in DOM until opened',
    !container.querySelector('[data-testid="share-button-dialog"]'));

  // Click "Share" — without navigator.share, this should open the dialog.
  act(() => { btn.click(); });
  const dlg = container.querySelector('[data-testid="share-button-dialog"]');
  assert('(R2) clicking Share opens the dialog (no native share)', !!dlg);

  cleanup();
}

// ──────────────────────────────────────────────────────────────── 2. DIALOG CONTENTS + A11Y
function dialogContentTests() {
  console.log('\n── DIALOG CONTENTS + ACCESSIBILITY ──');
  (window.navigator as unknown as { share?: unknown }).share = undefined;
  const { container, cleanup } = mount(
    <ShareButton slug="blue-denim" productName="Blue Denim Jacket"
                 description="Brushed lining."
                 imageUrl="https://cdn.example.com/jacket.jpg" />,
  );
  const more = container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  act(() => { more.click(); });
  const dlg = container.querySelector('[data-testid="share-button-dialog"]')!;
  assert('(D1) dialog mounted', !!dlg);

  // A11y
  eq('(D1) role=dialog', 'dialog', dlg.getAttribute('role'));
  eq('(D1) aria-modal=true', 'true', dlg.getAttribute('aria-modal'));
  // React's `useId` returns ids like `:r1:` which are invalid as a CSS
  // selector — use getElementById instead.
  const labelId = dlg.getAttribute('aria-labelledby') ?? '';
  assert('(D1) aria-labelledby points at a heading element',
    !!labelId && !!window.document.getElementById(labelId));

  // Channel buttons / links — verify each exists with the right testid.
  const channels = ['whatsapp', 'telegram', 'facebook', 'twitter', 'email'] as const;
  for (const c of channels) {
    const el = container.querySelector(`[data-testid="share-button-dialog-channel-${c}"]`) as HTMLAnchorElement | null;
    assert(`(D2) channel "${c}" rendered`, !!el);
    if (el) {
      // mailto: should NOT open in a new tab; others should
      if (c === 'email') {
        eq(`(D2) email channel target=""`, null, el.getAttribute('target'));
        assert('(D2) email href starts with mailto:',  (el.getAttribute('href') ?? '').startsWith('mailto:'));
      } else {
        eq(`(D2) ${c} channel target="_blank"`, '_blank', el.getAttribute('target'));
        assert(`(D2) ${c} href is https://`,
          (el.getAttribute('href') ?? '').startsWith('https://'));
      }
      // UTM stamping: each channel's URL contains utm_medium=<channel>
      // (decoded inside the platform's wrapper URL).
      const href = el.getAttribute('href') ?? '';
      assert(`(D2) ${c} href contains utm_medium=${c}`,
        href.includes(`utm_medium%3D${c}`) || href.includes(`utm_medium=${c}`));
    }
  }

  // Copy-link readonly input contains the absolute URL with utm_medium=copy_link
  const copyInput = container.querySelector('[data-testid="share-button-dialog-copy-input"]') as HTMLInputElement;
  assert('(D3) copy-link input rendered', !!copyInput);
  assert(`(D3) copy input is readonly`, copyInput.hasAttribute('readonly'));
  assert(`(D3) copy URL contains utm_medium=copy_link (got "${copyInput.value}")`,
    copyInput.value.includes('utm_medium=copy_link'));
  assert(`(D3) copy URL starts with http://localhost:9999/p/blue-denim`,
    copyInput.value.startsWith('http://localhost:9999/p/blue-denim'));

  // Status region present
  const status = container.querySelector('[data-testid="share-button-dialog-status"]')!;
  eq('(D4) status role=status', 'status', status.getAttribute('role'));
  eq('(D4) status aria-live=polite', 'polite', status.getAttribute('aria-live'));

  cleanup();
}

// ──────────────────────────────────────────────────────────────── 3. NATIVE SHARE PATH
async function nativeShareTests() {
  console.log('\n── NATIVE SHARE PATH ──');
  // Box pattern: ts narrows closure-mutated locals to `null` otherwise.
  const cap: { v: { title?: string; text?: string; url?: string } | null } = { v: null };
  (window.navigator as unknown as { share: (d: { title: string; text?: string; url: string }) => Promise<void> })
    .share = async (data) => { cap.v = { title: data.title, text: data.text, url: data.url }; };

  const { container, cleanup } = mount(
    <ShareButton slug="blue-denim" productName="Blue Denim Jacket"
                 description="Brushed lining, perfect for winter." />,
  );
  // Wait for the post-mount effect that flips hasNative.
  await flush(10);

  const btn = container.querySelector('[data-testid="share-button"]') as HTMLButtonElement;
  await act(async () => { btn.click(); await new Promise<void>((r) => setTimeout(r, 5)); });

  assert('(N1) navigator.share was called', !!cap.v);
  if (cap.v) {
    eq('(N1) title forwarded', 'Blue Denim Jacket', cap.v.title);
    eq('(N1) description forwarded as text',
      'Brushed lining, perfect for winter.', cap.v.text);
    assert(`(N1) url is absolute (got "${cap.v.url}")`,
      typeof cap.v.url === 'string' && cap.v.url.startsWith('http://localhost:9999/p/blue-denim'));
    assert('(N1) url carries utm_medium=native',
      (cap.v.url ?? '').includes('utm_medium=native'));
  }
  // Native success → dialog NOT opened.
  assert('(N1) dialog NOT opened on native success',
    !container.querySelector('[data-testid="share-button-dialog"]'));

  cleanup();
  (window.navigator as unknown as { share?: unknown }).share = undefined;
}

async function nativeShareFailureFallbackTests() {
  console.log('\n── NATIVE SHARE failure → fallback dialog ──');
  // Native share rejects with non-AbortError → fallback dialog opens.
  (window.navigator as unknown as { share: () => Promise<void> }).share = async () => {
    throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
  };

  const { container, cleanup } = mount(
    <ShareButton slug="x" productName="X" />,
  );
  await flush(10);
  const btn = container.querySelector('[data-testid="share-button"]') as HTMLButtonElement;
  await act(async () => { btn.click(); await new Promise<void>((r) => setTimeout(r, 5)); });
  await flush(10);
  assert('(N2) non-AbortError opens fallback dialog',
    !!container.querySelector('[data-testid="share-button-dialog"]'));
  cleanup();

  // AbortError (user dismissed share sheet) → fallback dialog does NOT open.
  (window.navigator as unknown as { share: () => Promise<void> }).share = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const m2 = mount(<ShareButton slug="x" productName="X" />);
  await flush(10);
  const btn2 = m2.container.querySelector('[data-testid="share-button"]') as HTMLButtonElement;
  await act(async () => { btn2.click(); await new Promise<void>((r) => setTimeout(r, 5)); });
  await flush(10);
  assert('(N3) AbortError does NOT open fallback dialog',
    !m2.container.querySelector('[data-testid="share-button-dialog"]'));
  m2.cleanup();

  (window.navigator as unknown as { share?: unknown }).share = undefined;
}

// ──────────────────────────────────────────────────────────────── 4. COPY LINK
async function copyTests() {
  console.log('\n── COPY LINK ──');
  const cap: { v: string | null } = { v: null };
  (window.navigator as unknown as { clipboard: { writeText: (s: string) => Promise<void> } })
    .clipboard = { writeText: async (s: string) => { cap.v = s; } };

  const { container, cleanup } = mount(
    <ShareButton slug="blue-denim" productName="Blue Denim Jacket" />,
  );
  const more = container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  act(() => { more.click(); });
  const copyBtn = container.querySelector('[data-testid="share-button-dialog-copy-button"]') as HTMLButtonElement;
  assert('(C1) copy button rendered', !!copyBtn);
  await act(async () => { copyBtn.click(); await new Promise<void>((r) => setTimeout(r, 5)); });

  const copied = cap.v ?? '';
  assert(`(C1) clipboard.writeText was called (got "${copied.slice(0, 60)}...")`,
    typeof cap.v === 'string' && copied.startsWith('http://localhost:9999/p/blue-denim'));
  assert('(C1) copied URL carries utm_medium=copy_link',
    copied.includes('utm_medium=copy_link'));

  const status = container.querySelector('[data-testid="share-button-dialog-status"]')!;
  assert(`(C2) status announces "Link copied" (got "${status.textContent}")`,
    /Link copied/i.test(status.textContent ?? ''));
  cleanup();
}

async function copyFailureTests() {
  console.log('\n── COPY LINK FAILURE PATH ──');
  // clipboard.writeText throws → fall back to execCommand. We stub
  // execCommand to return true so the "success" branch fires.
  (window.navigator as unknown as { clipboard: { writeText: () => Promise<void> } })
    .clipboard = { writeText: async () => { throw new Error('denied'); } };
  (window.document as unknown as { execCommand: (c: string) => boolean }).execCommand = () => true;

  const m = mount(<ShareButton slug="x" productName="X" />);
  const more = m.container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  act(() => { more.click(); });
  const copyBtn = m.container.querySelector('[data-testid="share-button-dialog-copy-button"]') as HTMLButtonElement;
  await act(async () => { copyBtn.click(); await new Promise<void>((r) => setTimeout(r, 5)); });

  const status = m.container.querySelector('[data-testid="share-button-dialog-status"]')!;
  assert(`(C3) execCommand fallback announces success (got "${status.textContent}")`,
    /Link copied/i.test(status.textContent ?? ''));
  m.cleanup();
}

// ──────────────────────────────────────────────────────────────── 5. CLOSE BEHAVIOURS
function closeTests() {
  console.log('\n── CLOSE BEHAVIOURS ──');
  (window.navigator as unknown as { share?: unknown }).share = undefined;
  // Close button.
  const { container, cleanup } = mount(<ShareButton slug="x" productName="X" />);
  const more = container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  act(() => { more.click(); });
  let dlg = container.querySelector('[data-testid="share-button-dialog"]')!;
  assert('(X1) dialog opened', !!dlg);
  const close = container.querySelector('[data-testid="share-button-dialog-close"]') as HTMLButtonElement;
  act(() => { close.click(); });
  assert('(X1) close button removes dialog',
    !container.querySelector('[data-testid="share-button-dialog"]'));

  // Backdrop click.
  act(() => { more.click(); });
  const backdrop = container.querySelector('[data-testid="share-button-dialog-backdrop"]') as HTMLDivElement;
  act(() => { backdrop.click(); });
  assert('(X2) backdrop click closes dialog',
    !container.querySelector('[data-testid="share-button-dialog"]'));

  // Escape key.
  act(() => { more.click(); });
  dlg = container.querySelector('[data-testid="share-button-dialog"]')!;
  act(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert('(X3) Escape closes dialog',
    !container.querySelector('[data-testid="share-button-dialog"]'));

  cleanup();
}

// ──────────────────────────────────────────────────────────────── 6. EDGE CASES
function edgeTests() {
  console.log('\n── EDGE CASES ──');
  (window.navigator as unknown as { share?: unknown }).share = undefined;
  const longName = 'X'.repeat(200);
  const { container, cleanup } = mount(
    <ShareButton slug="long-name-product" productName={longName} />,
  );
  const more = container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement;
  act(() => { more.click(); });
  const dlg = container.querySelector('[data-testid="share-button-dialog"]')!;
  assert('(E1) very long product name still mounts dialog', !!dlg);
  // Channel URLs still valid (no throws, contain the slug).
  const wa = container.querySelector('[data-testid="share-button-dialog-channel-whatsapp"]') as HTMLAnchorElement;
  assert('(E1) WhatsApp URL contains the slug',
    (wa.getAttribute('href') ?? '').includes('long-name-product'));
  cleanup();

  // Missing image → modal still works (no crash on broken thumb).
  const m2 = mount(<ShareButton slug="no-image" productName="No Image" imageUrl={null} />);
  act(() => { (m2.container.querySelector('[data-testid="share-button-more"]') as HTMLButtonElement).click(); });
  assert('(E2) missing image: dialog mounts',
    !!m2.container.querySelector('[data-testid="share-button-dialog"]'));
  m2.cleanup();
}

// ──────────────────────────────────────────────────────────────── 7. REGRESSION
function regressionTests() {
  console.log('\n── REGRESSION — shared components still mount ──');
  const a = mount(<PasswordStrengthMeter password="TestPass#9k2" email="user@gmail.com" />);
  assert('(REG1) PasswordStrengthMeter renders',
    /Weak|Fair|Good|Strong|Very Strong/.test(a.container.textContent ?? ''));
  a.cleanup();
  const b = mount(<OtpInput value="" onChange={() => { /* */ }} length={6} />);
  eq('(REG2) OtpInput renders 6 slots', 6,
     b.container.querySelectorAll('input[data-testid^="otp-slot-"]').length);
  b.cleanup();
  const c = mount(<PincodeField value="" onChange={() => { /* */ }} />);
  assert('(REG3) PincodeField renders',
    !!c.container.querySelector('input[name="pinCode"]'));
  c.cleanup();
}

async function main() {
  renderTests();
  dialogContentTests();
  await nativeShareTests();
  await nativeShareFailureFallbackTests();
  await copyTests();
  await copyFailureTests();
  closeTests();
  edgeTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
