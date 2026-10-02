/**
 * Feature #13 — PincodeField component test suite.
 *
 *   npm run test:pincode-ui
 *
 * Runs entirely in jsdom (no spawned server) with a controllable fetch
 * mock. Exercises every spec'd behaviour:
 *
 *   - Renders label + input + aria-describedby live region
 *   - Strips non-digits while typing
 *   - DOES NOT fire lookup until 6 digits + 300ms (configurable) debounce
 *   - Fires exactly one lookup for a stable 6-digit value
 *   - RACE-SAFE: rapid changes (110001 → 400001 → 560001) commit only the
 *     LATEST response, even if earlier responses resolve out of order
 *   - Renders post-office dropdown when result has ≥ 2 PostOffices
 *   - Picking from the dropdown re-applies autofill
 *   - Renders the "📍 …Verified by India Post" summary card on success
 *   - "Not found" message rendered for found:false envelopes
 *   - Network failure surfaces a friendly message + does NOT block form
 *   - Accessibility: role="status", aria-live="polite", aria-invalid,
 *     dropdown aria-label, status live region tied to input via aria-describedby
 *   - REGRESSION: <PasswordStrengthMeter> + <OtpInput> still render
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
(globalThis as unknown as { HTMLSelectElement: typeof HTMLSelectElement }).HTMLSelectElement = window.HTMLSelectElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
(globalThis as unknown as { Response: typeof window.Response }).Response = window.Response;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);
{
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (event: string, fn: () => void) => void;
    detachEvent?: (event: string, fn: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => { /* noop */ };
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => { /* noop */ };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import PincodeField, { type PincodeAutofill } from '../src/components/forms/PincodeField';
import PasswordStrengthMeter from '../src/components/auth/PasswordStrengthMeter';
import OtpInput from '../src/components/auth/OtpInput';
import type { PincodeVerification } from '../src/lib/pincode/types';

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
async function flush(ms = 0): Promise<void> {
  await act(async () => { await new Promise<void>((r) => setTimeout(r, ms)); });
}

// ── mock fetch ────────────────────────────────────────────────────────────
type Envelope =
  | { ok: true;  data: PincodeVerification }
  | { ok: false; error: string };
type FetchMockHandler = (url: string) => Promise<Envelope> | Envelope;
let fetchHandler: FetchMockHandler = () => ({ ok: false, error: 'no-handler' });
let fetchCalls: string[] = [];

(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  fetchCalls.push(url);
  const r = await fetchHandler(url);
  // Hand-roll a Response-like object — jsdom's Response body parsing is
  // unreliable across versions. The component only uses .json() + .ok.
  const text = JSON.stringify(r);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() { return JSON.parse(text); },
    async text() { return text; },
  } as unknown as Response;
}) as typeof fetch;

// ── helpers ───────────────────────────────────────────────────────────────
function mount(node: React.ReactElement) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    root, container,
    cleanup() { act(() => { root.unmount(); }); container.remove(); },
  };
}
function reactInput(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  desc?.set?.call(el, value);
  const tracker = (el as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  if (tracker) tracker.setValue('');
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (fiberKey) {
    type Props = { onChange?: (e: { target: HTMLInputElement }) => void };
    const props = (el as unknown as Record<string, Props>)[fiberKey];
    desc?.set?.call(el, value);
    props?.onChange?.({ target: el });
  }
}
function selectChange(el: HTMLSelectElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (fiberKey) {
    type Props = { onChange?: (e: { target: HTMLSelectElement }) => void };
    const props = (el as unknown as Record<string, Props>)[fiberKey];
    desc?.set?.call(el, value);
    props?.onChange?.({ target: el });
  }
}

/** Box pattern — avoids TypeScript narrowing closure-mutated locals to never. */
function makeBox<T>(): { v: T | null } { return { v: null }; }

function Harness(props: {
  initial?: string;
  debounceMs?: number;
  onAutofill?: (a: PincodeAutofill) => void;
}) {
  const [v, setV] = useState(props.initial ?? '');
  return (
    <PincodeField
      value={v}
      onChange={setV}
      onAutofill={props.onAutofill}
      debounceMs={props.debounceMs ?? 50 /* short for tests */}
    />
  );
}

// ── canned data ───────────────────────────────────────────────────────────
const VERIF_DELHI: PincodeVerification = {
  pincode: '110001', found: true,
  postOffices: [
    { name: 'Connaught Place', branchType: 'Sub Office', deliveryStatus: 'Delivery',
      district: 'Central Delhi', division: 'New Delhi Central', region: 'Delhi',
      circle: 'Delhi', block: 'New Delhi', state: 'Delhi', country: 'India' },
    { name: 'Sansad Marg H.O', branchType: 'Head Office', deliveryStatus: 'Delivery',
      district: 'Central Delhi', division: 'New Delhi Central', region: 'Delhi',
      circle: 'Delhi', block: 'New Delhi', state: 'Delhi', country: 'India' },
  ],
  state: 'Delhi', district: 'Central Delhi', city: 'Delhi',
  isServiceable: true, source: 'india-post', lookupMs: 20,
};
const VERIF_BENGALURU: PincodeVerification = {
  pincode: '560001', found: true,
  postOffices: [{ name: 'Bangalore G.P.O.', branchType: 'Head Office', deliveryStatus: 'Delivery',
    district: 'Bengaluru Urban', division: 'Bengaluru GPO', region: 'Bengaluru',
    circle: 'Karnataka', block: null, state: 'Karnataka', country: 'India' }],
  state: 'Karnataka', district: 'Bengaluru Urban', city: 'Bengaluru',
  isServiceable: true, source: 'india-post', lookupMs: 17,
};
const VERIF_MUMBAI: PincodeVerification = {
  pincode: '400001', found: true,
  postOffices: [{ name: 'Mumbai G.P.O.', branchType: 'Head Office', deliveryStatus: 'Delivery',
    district: 'Mumbai', division: 'Mumbai GPO', region: 'Mumbai', circle: 'Maharashtra',
    block: null, state: 'Maharashtra', country: 'India' }],
  state: 'Maharashtra', district: 'Mumbai', city: 'Mumbai',
  isServiceable: true, source: 'india-post', lookupMs: 12,
};
const VERIF_NOTFOUND: PincodeVerification = {
  pincode: '999999', found: false, postOffices: [],
  state: null, district: null, city: null,
  isServiceable: false, source: 'india-post', lookupMs: 5,
  message: 'Pincode not recognised. Please check and try again.',
};

// ────────────────────────────────────────────────────────────── 1. RENDER + A11Y
function renderTests() {
  console.log('\n── RENDER + ACCESSIBILITY ──');
  fetchHandler = () => ({ ok: true, data: VERIF_DELHI });
  const { container, cleanup } = mount(<Harness />);

  const input = container.querySelector('input[name="pinCode"]') as HTMLInputElement;
  assert('(R1) input rendered', !!input);
  eq('(R1) input inputmode = numeric', 'numeric', input.getAttribute('inputmode'));
  eq('(R1) input maxlength = 6', '6', input.getAttribute('maxlength'));
  eq('(R1) input autocomplete = postal-code', 'postal-code', input.getAttribute('autocomplete'));

  const live = container.querySelector('[role="status"]')!;
  eq('(R2) live region aria-live = polite', 'polite', live.getAttribute('aria-live'));

  assert('(R3) input is aria-described-by the status region',
    input.getAttribute('aria-describedby') === live.getAttribute('id'));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 2. TYPING + DEBOUNCE
async function typingTests() {
  console.log('\n── TYPING + DEBOUNCE ──');
  fetchCalls = [];
  fetchHandler = () => ({ ok: true, data: VERIF_DELHI });
  const { container, cleanup } = mount(<Harness debounceMs={50} />);
  const input = container.querySelector('input[name="pinCode"]') as HTMLInputElement;

  // (T1) Typing 3 digits → NO fetch (length < 6).
  act(() => { reactInput(input, '110'); });
  await flush(80);
  eq('(T1) no fetch for incomplete PIN', 0, fetchCalls.length);

  // (T2) Typing all 6 → fetch fires after debounce.
  act(() => { reactInput(input, '110001'); });
  await flush(80);
  eq('(T2) one fetch for complete PIN', 1, fetchCalls.length);
  assert(`(T2) fetch URL = /api/pincode/110001 (got ${fetchCalls[0]})`,
    /\/api\/pincode\/110001$/.test(fetchCalls[0]));

  // (T3) Letters are stripped on input.
  fetchCalls = [];
  act(() => { reactInput(input, 'abc560001def'); });
  await flush(80);
  eq('(T3) non-digit input stripped, exactly 1 fetch', 1, fetchCalls.length);
  assert(`(T3) fetch URL for stripped = /api/pincode/560001 (got ${fetchCalls[0]})`,
    /\/api\/pincode\/560001$/.test(fetchCalls[0]));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 3. AUTOFILL + CARD
async function autofillTests() {
  console.log('\n── AUTOFILL + ADDRESS CARD ──');
  fetchCalls = [];
  fetchHandler = () => ({ ok: true, data: VERIF_BENGALURU });
  const box = makeBox<PincodeAutofill>();
  const { container, cleanup } = mount(
    <Harness debounceMs={30} onAutofill={(a) => { box.v = a; }} />,
  );
  const input = container.querySelector('input[name="pinCode"]') as HTMLInputElement;

  act(() => { reactInput(input, '560001'); });
  await flush(80);

  assert('(A1) onAutofill fired', box.v != null);
  eq('(A1) autofill.city = "Bengaluru"',       'Bengaluru',       box.v?.city);
  eq('(A1) autofill.state = "Karnataka"',      'Karnataka',       box.v?.state);
  eq('(A1) autofill.district = "Bengaluru Urban"', 'Bengaluru Urban', box.v?.district);
  eq('(A1) autofill.isServiceable = true',     true,              box.v?.isServiceable);

  const card = container.querySelector('[data-testid="pincode-field-card"]')!;
  assert('(A2) "📍" summary card rendered', !!card && /Verified by India Post/i.test(card.textContent ?? ''));
  assert('(A2) card shows the city',  /Bengaluru/.test(card.textContent ?? ''));
  assert('(A2) card shows the state', /Karnataka/.test(card.textContent ?? ''));
  assert('(A2) card shows the pincode', /560001/.test(card.textContent ?? ''));

  const status = container.querySelector('[role="status"]')!;
  assert('(A3) status row announces "Bengaluru, Karnataka"',
    /Bengaluru.*Karnataka/.test(status.textContent ?? ''));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 4. MULTI-OFFICE DROPDOWN
async function dropdownTests() {
  console.log('\n── MULTI-OFFICE DROPDOWN ──');
  fetchHandler = () => ({ ok: true, data: VERIF_DELHI });
  const box = makeBox<PincodeAutofill>();
  const { container, cleanup } = mount(
    <Harness debounceMs={30} onAutofill={(a) => { box.v = a; }} />,
  );
  const input = container.querySelector('input[name="pinCode"]') as HTMLInputElement;
  act(() => { reactInput(input, '110001'); });
  await flush(80);

  const select = container.querySelector('select[data-testid="pincode-field-select"]') as HTMLSelectElement;
  assert('(D1) dropdown rendered for multi-office PIN', !!select);
  eq('(D1) dropdown has 2 options', 2, select.querySelectorAll('option').length);
  eq('(D1) dropdown has aria-label', 'Choose post office', select.getAttribute('aria-label'));

  // Pick a different option.
  act(() => { selectChange(select, 'Sansad Marg H.O'); });
  await flush(20);
  eq('(D2) onAutofill re-fires with the picked office',
     'Sansad Marg H.O', box.v?.postOffice?.name ?? '<missing>');

  cleanup();
}

// ────────────────────────────────────────────────────────────── 5. RACE SAFETY
async function raceTests() {
  console.log('\n── RACE SAFETY ──');
  fetchCalls = [];

  type Resolver = (v: Envelope) => void;
  const queue: Array<{ pin: string; resolve: Resolver }> = [];
  fetchHandler = (url: string) => new Promise<Envelope>((resolve) => {
    const pin = url.split('/').pop()!;
    queue.push({ pin, resolve });
  });

  const box = makeBox<PincodeAutofill>();
  const { container, cleanup } = mount(
    <Harness debounceMs={5} onAutofill={(a) => { box.v = a; }} />,
  );
  const input = container.querySelector('input[name="pinCode"]') as HTMLInputElement;

  act(() => { reactInput(input, '110001'); });
  await flush(15);
  act(() => { reactInput(input, '400001'); });
  await flush(15);
  act(() => { reactInput(input, '560001'); });
  await flush(15);

  assert(`(X1) three fetches scheduled (got ${queue.length})`, queue.length === 3);

  const r110 = queue.find((q) => q.pin === '110001')!;
  const r400 = queue.find((q) => q.pin === '400001')!;
  const r560 = queue.find((q) => q.pin === '560001')!;

  // Resolve in REVERSE order — latest first.
  await act(async () => {
    r560.resolve({ ok: true, data: VERIF_BENGALURU });
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => {
    r110.resolve({ ok: true, data: VERIF_DELHI });
    r400.resolve({ ok: true, data: VERIF_MUMBAI });
    await new Promise((r) => setTimeout(r, 10));
  });
  await flush(20);

  // Only the LATEST (560001 → Bengaluru) should have applied.
  eq('(X2) only the latest typed PIN commits city',  'Bengaluru', box.v?.city  ?? '<missing>');
  eq('(X2) only the latest typed PIN commits state', 'Karnataka', box.v?.state ?? '<missing>');
  const status = container.querySelector('[role="status"]')!;
  assert('(X2) status row shows the latest city',
    /Bengaluru/.test(status.textContent ?? '') &&
    !/(Delhi|Mumbai)/.test(status.textContent ?? ''));

  cleanup();
}

// ────────────────────────────────────────────────────────────── 6. NOT-FOUND + ERROR PATHS
async function failurePathTests() {
  console.log('\n── NOT-FOUND + ERROR PATHS ──');

  // (F1) Not found
  fetchHandler = () => ({ ok: true, data: VERIF_NOTFOUND });
  const box1 = makeBox<PincodeAutofill>();
  const m1 = mount(<Harness debounceMs={20} onAutofill={(a) => { box1.v = a; }} />);
  const i1 = m1.container.querySelector('input[name="pinCode"]') as HTMLInputElement;
  act(() => { reactInput(i1, '999999'); });
  await flush(60);
  eq('(F1) onAutofill NOT called on not-found', null, box1.v);
  const status1 = m1.container.querySelector('[role="status"]')!;
  assert('(F1) status row shows the "not recognised" message',
    /not recognised/i.test(status1.textContent ?? ''));
  assert('(F1) summary card NOT rendered',
    !m1.container.querySelector('[data-testid="pincode-field-card"]'));
  eq('(F1) input has aria-invalid="true"', 'true', i1.getAttribute('aria-invalid'));
  m1.cleanup();

  // (F2) Server-side error envelope
  fetchHandler = () => ({ ok: false, error: 'simulated network failure' });
  const box2 = makeBox<PincodeAutofill>();
  const m2 = mount(<Harness debounceMs={20} onAutofill={(a) => { box2.v = a; }} />);
  const i2 = m2.container.querySelector('input[name="pinCode"]') as HTMLInputElement;
  act(() => { reactInput(i2, '111111'); });
  await flush(60);
  eq('(F2) onAutofill NOT called on error', null, box2.v);
  const status2 = m2.container.querySelector('[role="status"]')!;
  assert('(F2) status row shows an error message',
    (status2.textContent ?? '').length > 0);
  m2.cleanup();
}

// ────────────────────────────────────────────────────────────── 7. UNSERVICEABLE PATH
async function unserviceableTests() {
  console.log('\n── UNSERVICEABLE WARNING ──');
  const unservPayload: PincodeVerification = {
    ...VERIF_BENGALURU,
    pincode: '560003',
    isServiceable: false,
  };
  fetchHandler = () => ({ ok: true, data: unservPayload });
  const m = mount(<Harness debounceMs={20} />);
  const inp = m.container.querySelector('input[name="pinCode"]') as HTMLInputElement;
  act(() => { reactInput(inp, '560003'); });
  await flush(60);
  const warn = m.container.querySelector('[data-testid="pincode-field-unserviceable"]');
  assert('(U1) unserviceable warning rendered', !!warn);
  m.cleanup();
}

// ────────────────────────────────────────────────────────────── 8. REGRESSION
function regressionTests() {
  console.log('\n── REGRESSION — shared components still render ──');
  const a = mount(<PasswordStrengthMeter password="TestPass#9k2" email="user@gmail.com" />);
  assert('(REG1) PasswordStrengthMeter renders a level label',
    /Weak|Fair|Good|Strong|Very Strong/.test(a.container.textContent ?? ''));
  a.cleanup();
  const b = mount(<OtpInput value="" onChange={() => { /* */ }} length={6} />);
  eq('(REG2) OtpInput renders 6 slots', 6,
     b.container.querySelectorAll('input[data-testid^="otp-slot-"]').length);
  b.cleanup();
}

// ────────────────────────────────────────────────────────────── MAIN
async function main() {
  renderTests();
  await typingTests();
  await autofillTests();
  await dropdownTests();
  await raceTests();
  await failurePathTests();
  await unserviceableTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
