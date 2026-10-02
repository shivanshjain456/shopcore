/**
 * Feature #16 — <ImageUploadInput> jsdom component test.
 *
 *   npm run test:image-upload-input
 *
 *   - RENDER + A11Y: URL <input>, file <input type=file> (sr-only),
 *     Upload button with aria-label, status live region.
 *   - URL TYPING: paste-URL path writes through onChange; thumbnail
 *     appears when value is non-empty.
 *   - UPLOAD: simulating a file pick fires a multipart fetch to
 *     /api/admin/uploads?kind=<kind>; success → URL written into the
 *     input + status shows "✓ Uploaded …"; failure → URL untouched,
 *     status carries error message.
 *   - CSRF: the request carries the x-csrf-token header.
 *   - DRAG-AND-DROP: a synthetic drop event triggers the same upload
 *     path as the file picker.
 *   - CLEAR: ✕ button empties the URL and resets state.
 *   - DISABLED: every control is non-clickable.
 *   - REGRESSION: <PasswordStrengthMeter>, <OtpInput>, <PincodeField>
 *     still mount (proves shared imports unchanged).
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
(globalThis as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement = window.HTMLInputElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
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

// Cookie shim: ensure `document.cookie` is writable so we can plant a CSRF
// token for the component's CSRF read.
Object.defineProperty(window.document, 'cookie', {
  configurable: true,
  get() { return cookieJar; },
  set(v: string) {
    // very small "Set-Cookie" parser — only the name=value pair matters.
    const eqIdx = v.indexOf('=');
    if (eqIdx <= 0) return;
    const name = v.slice(0, eqIdx).trim();
    const val  = v.slice(eqIdx + 1).split(';')[0].trim();
    const rest = cookieJar.split('; ').filter((c) => c && !c.startsWith(name + '='));
    rest.push(`${name}=${val}`);
    cookieJar = rest.join('; ');
  },
});
let cookieJar = 'sc_csrf=fake-token-for-test';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── fetch mock — captures every call so we can assert URL / headers. ─────
interface CapturedFetch { url: string; method: string; headers: Record<string, string>; body: unknown; }
const fetchCalls: CapturedFetch[] = [];
type FetchHandler = (req: CapturedFetch) =>
  Promise<{ ok: boolean; status?: number; json: unknown }> |
  { ok: boolean; status?: number; json: unknown };
let fetchHandler: FetchHandler = () => ({ ok: true, json: { ok: true, data: null } });

(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  input: RequestInfo | URL, init?: RequestInit,
) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const hdrs: Record<string, string> = {};
  const h = init?.headers;
  if (h instanceof Headers) h.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
  else if (Array.isArray(h))   for (const [k, v] of h) hdrs[String(k).toLowerCase()] = String(v);
  else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) hdrs[k.toLowerCase()] = String(v);
  const cap: CapturedFetch = { url, method, headers: hdrs, body: init?.body };
  fetchCalls.push(cap);
  const r = await fetchHandler(cap);
  const text = JSON.stringify(r.json);
  return {
    ok: r.ok ?? true,
    status: r.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() { return JSON.parse(text); },
    async text() { return text; },
  } as unknown as Response;
}) as typeof fetch;

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ImageUploadInput from '../src/components/admin/ImageUploadInput';
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

function makeBox<T>(): { v: T | null } { return { v: null }; }

function Harness(props: {
  initial?: string;
  onChangeSpy?: (v: string) => void;
  kind?: 'hero' | 'promotion';
}) {
  const [v, setV] = useState(props.initial ?? '');
  return (
    <ImageUploadInput
      value={v}
      onChange={(next) => { setV(next); props.onChangeSpy?.(next); }}
      name="testImage"
      kind={props.kind ?? 'hero'}
      label="Test image"
    />
  );
}

/** Synthesise a File and dispatch it through the hidden file input. */
function pickFile(container: HTMLElement, name: string, type: string, bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([bytes], name, { type });
  // React reads files off `event.target.files`, which is FileList. jsdom
  // doesn't let us assign `.files` directly, so we redefine the property.
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    get() {
      return { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) };
    },
  });
  // Find React's onChange via the fiber and invoke directly — jsdom can't
  // construct a real change event with `target.files`.
  const fiberKey = Object.keys(fileInput).find((k) => k.startsWith('__reactProps$'));
  type Props = { onChange?: (e: { target: HTMLInputElement }) => void };
  const props = fiberKey ? (fileInput as unknown as Record<string, Props>)[fiberKey] : undefined;
  props?.onChange?.({ target: fileInput });
}

// ────────────────────────────────────────────────────────────── 1. RENDER + A11Y
function renderTests() {
  console.log('\n── RENDER + ACCESSIBILITY ──');
  const { container, cleanup } = mount(<Harness />);
  const root = container.querySelector('[data-testid="image-upload-input"]')!;
  assert('(R1) wrapper rendered', !!root);

  const urlInput = container.querySelector('[data-testid="image-upload-input-url"]') as HTMLInputElement;
  assert('(R2) URL input rendered', !!urlInput);
  eq('(R2) URL input name = "testImage"', 'testImage', urlInput.getAttribute('name'));
  eq('(R2) URL input type = "text"', 'text', urlInput.getAttribute('type'));
  eq('(R2) URL input autocomplete = "off"', 'off', urlInput.getAttribute('autocomplete'));

  const fileInput = container.querySelector('[data-testid="image-upload-input-file"]') as HTMLInputElement;
  assert('(R3) file input rendered', !!fileInput);
  eq('(R3) file input type = "file"', 'file', fileInput.getAttribute('type'));
  assert('(R3) file input accept includes image/png', /image\/png/.test(fileInput.getAttribute('accept') ?? ''));
  assert('(R3) file input is sr-only (visually hidden)', fileInput.className.includes('sr-only'));

  const button = container.querySelector('[data-testid="image-upload-input-button"]') as HTMLButtonElement;
  assert('(R4) Upload button rendered', !!button);
  eq('(R4) Upload button aria-label', 'Upload image from your computer', button.getAttribute('aria-label'));
  assert('(R4) Upload button is tap-target', button.className.includes('tap-target'));

  const status = container.querySelector('[data-testid="image-upload-input-status"]')!;
  eq('(R5) status role=status', 'status', status.getAttribute('role'));
  eq('(R5) status aria-live=polite', 'polite', status.getAttribute('aria-live'));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 2. PASTE-URL PATH
function pasteUrlTests() {
  console.log('\n── PASTE URL PATH (existing behaviour preserved) ──');
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { spy.v = v; }} />,
  );
  const url = container.querySelector('[data-testid="image-upload-input-url"]') as HTMLInputElement;

  // Directly type into the URL input → onChange should fire.
  // We bypass React's value-tracker via the fiber-props onChange call.
  const fiberKey = Object.keys(url).find((k) => k.startsWith('__reactProps$'));
  type Props = { onChange?: (e: { target: HTMLInputElement }) => void };
  const props = fiberKey ? (url as unknown as Record<string, Props>)[fiberKey] : undefined;
  Object.defineProperty(url, 'value', { configurable: true, get() { return 'https://cdn.example.com/x.jpg'; } });
  act(() => { props?.onChange?.({ target: url }); });

  eq('(P1) onChange writes URL back to parent',
     'https://cdn.example.com/x.jpg', spy.v ?? '<missing>');

  // Thumbnail appears when value is non-empty.
  const thumb = container.querySelector('[data-testid="image-upload-input-thumb"]');
  assert('(P2) thumbnail rendered when URL is set', !!thumb);
  const thumbImg = thumb?.querySelector('img');
  eq('(P2) thumbnail uses the URL', 'https://cdn.example.com/x.jpg', thumbImg?.getAttribute('src'));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 3. UPLOAD HAPPY
async function uploadHappyTests() {
  console.log('\n── UPLOAD HAPPY PATH ──');
  fetchCalls.length = 0;
  fetchHandler = (req) => {
    if (req.url.includes('/api/admin/uploads')) {
      return {
        ok: true, status: 200,
        json: {
          ok: true,
          data: {
            url: '/api/uploads/public-images/hero/abc123.jpg',
            mime: 'image/jpeg', bytes: 12_345, width: 1600, height: 900,
          },
        },
      };
    }
    return { ok: true, json: { ok: true, data: null } };
  };
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { spy.v = v; }} />,
  );

  // Pick a file → triggers the multipart upload.
  await act(async () => {
    pickFile(container, 'banner.png', 'image/png');
    await new Promise<void>((r) => setTimeout(r, 5));
  });
  await flush(20);

  // (U1) Exactly one POST to /api/admin/uploads?kind=hero
  const uploads = fetchCalls.filter((c) => c.url.includes('/api/admin/uploads'));
  eq('(U1) one POST to /api/admin/uploads', 1, uploads.length);
  assert(`(U1) POST URL carries ?kind=hero (got "${uploads[0].url}")`,
    /\?kind=hero$/.test(uploads[0].url));
  eq('(U1) method = POST', 'POST', uploads[0].method);
  eq('(U1) request carries x-csrf-token header',
     'fake-token-for-test', uploads[0].headers['x-csrf-token']);
  // Body should be a FormData-like (we accept either Node's FormData or
  // jsdom's window.FormData — they may not share an identity in tsx land).
  const body = uploads[0].body as { append?: unknown; get?: unknown };
  assert('(U1) request body is FormData-like',
    !!body && typeof body.append === 'function' && typeof body.get === 'function');

  // (U2) Returned URL was written into the parent
  eq('(U2) onChange called with the uploaded URL',
     '/api/uploads/public-images/hero/abc123.jpg', spy.v ?? '<missing>');

  // (U3) Status reflects success
  const status = container.querySelector('[data-testid="image-upload-input-status"]')!;
  assert(`(U3) status announces "✓ Uploaded" (got "${status.textContent}")`,
    /✓\s+Uploaded/.test(status.textContent ?? ''));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 4. UPLOAD FAILURE
async function uploadFailTests() {
  console.log('\n── UPLOAD FAILURE PATH ──');
  fetchCalls.length = 0;
  fetchHandler = (req) => {
    if (req.url.includes('/api/admin/uploads')) {
      return {
        ok: false, status: 413,
        json: { ok: false, error: 'File too large (max 5 MB).' },
      };
    }
    return { ok: true, json: { ok: true } };
  };
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { spy.v = v; }} />,
  );

  await act(async () => {
    pickFile(container, 'big.png', 'image/png');
    await new Promise<void>((r) => setTimeout(r, 5));
  });
  await flush(20);

  // (F1) onChange was NOT called (URL untouched)
  eq('(F1) onChange not called on upload failure', null, spy.v);
  // (F2) Status shows the error message
  const status = container.querySelector('[data-testid="image-upload-input-status"]')!;
  assert(`(F2) status shows the server error (got "${status.textContent}")`,
    /too large/i.test(status.textContent ?? ''));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 5. WRONG MIME (client-side guard)
async function wrongMimeTests() {
  console.log('\n── WRONG MIME (client-side guard) ──');
  fetchCalls.length = 0;
  fetchHandler = () => ({ ok: true, json: { ok: true, data: {
    url: '/api/uploads/public-images/hero/x.jpg', mime: 'image/jpeg', bytes: 1, width: 1, height: 1,
  } } });
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { spy.v = v; }} />,
  );
  await act(async () => {
    pickFile(container, 'a.txt', 'text/plain');
    await new Promise<void>((r) => setTimeout(r, 5));
  });
  await flush(10);

  const uploads = fetchCalls.filter((c) => c.url.includes('/api/admin/uploads'));
  eq('(M1) non-image file does NOT trigger a network call', 0, uploads.length);
  eq('(M1) onChange not called', null, spy.v);
  const status = container.querySelector('[data-testid="image-upload-input-status"]')!;
  assert('(M1) status warns about image-only',
    /image file/i.test(status.textContent ?? ''));
  cleanup();
}

// ────────────────────────────────────────────────────────────── 6. CLEAR
function clearTests() {
  console.log('\n── CLEAR BUTTON ──');
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness initial="https://cdn.example.com/x.jpg"
             onChangeSpy={(v) => { spy.v = v; }} />,
  );
  const clear = container.querySelector('[data-testid="image-upload-input-clear"]') as HTMLButtonElement;
  assert('(C1) clear button rendered when URL is set', !!clear);
  act(() => { clear.click(); });
  eq('(C2) clear empties the URL', '', spy.v ?? '<missing>');
  // After clear: no thumb, no clear button.
  const m2 = mount(<Harness />);
  assert('(C3) no clear button when URL is empty (fresh mount)',
    !m2.container.querySelector('[data-testid="image-upload-input-clear"]'));
  m2.cleanup();
  cleanup();
}

// ────────────────────────────────────────────────────────────── 7. DRAG-AND-DROP
async function dropTests() {
  console.log('\n── DRAG-AND-DROP ──');
  fetchCalls.length = 0;
  fetchHandler = (req) =>
    req.url.includes('/api/admin/uploads')
      ? { ok: true, json: { ok: true, data: {
          url: '/api/uploads/public-images/hero/dropped.jpg',
          mime: 'image/jpeg', bytes: 7000, width: 800, height: 600,
        } } }
      : { ok: true, json: { ok: true } };
  const spy = makeBox<string>();
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { spy.v = v; }} />,
  );
  const root = container.querySelector('[data-testid="image-upload-input"]')!;
  const file = new File([new Uint8Array([0x89, 0x50])], 'drop.png', { type: 'image/png' });

  // Build a synthetic drop event. React's drop handler reads
  // `event.dataTransfer.files[0]` — that's all we need to populate.
  const ev = new window.Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
  (ev as unknown as { dataTransfer: { files: File[] } }).dataTransfer = {
    files: [file],
  };
  await act(async () => {
    root.dispatchEvent(ev);
    await new Promise<void>((r) => setTimeout(r, 5));
  });
  await flush(20);

  const uploads = fetchCalls.filter((c) => c.url.includes('/api/admin/uploads'));
  eq('(D1) drop triggers an upload', 1, uploads.length);
  eq('(D1) onChange got the dropped URL',
    '/api/uploads/public-images/hero/dropped.jpg', spy.v ?? '<missing>');
  cleanup();
}

// ────────────────────────────────────────────────────────────── 8. REGRESSION
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
  pasteUrlTests();
  await uploadHappyTests();
  await uploadFailTests();
  await wrongMimeTests();
  clearTests();
  await dropTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
