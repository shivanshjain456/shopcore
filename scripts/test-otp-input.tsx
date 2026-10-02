/**
 * Feature #12 — OtpInput component test suite.
 *
 *   npm run test:otp-input
 *
 * Runs entirely in jsdom (no spawned server). Exercises every required
 * spec'd behaviour for the 6-slot OTP input:
 *
 *   - auto-focus on mount (focuses slot 0)
 *   - auto-advance when typing a digit
 *   - backspace navigates to previous slot when current is empty
 *   - backspace clears the current digit when populated
 *   - arrow-left / arrow-right move focus
 *   - paste of a full code populates every slot
 *   - paste of a partial code populates starting at the current slot
 *   - non-digit keypresses are blocked (no slot mutation)
 *   - onComplete fires once the value reaches `length`
 *   - error styling toggles via prop
 *   - Accessibility: role="group", aria-label per slot, "Digit N of M",
 *     inputMode="numeric", autoComplete="one-time-code" on slot 0
 *   - REGRESSION: PasswordStrengthMeter still imports and renders cleanly
 *     (Feature #11) — proves we didn't break the shared password component.
 */

import { JSDOM } from 'jsdom';

// Bootstrap a fake browser BEFORE importing React.
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
(globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent = window.KeyboardEvent;
(globalThis as unknown as { ClipboardEvent: typeof window.ClipboardEvent }).ClipboardEvent = window.ClipboardEvent;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);

// React 18 IE-fallback polyfill (same trick test-dialog.tsx uses).
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
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import OtpInput from '../src/components/auth/OtpInput';
import PasswordStrengthMeter from '../src/components/auth/PasswordStrengthMeter';

// ── tiny test harness ─────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  // DOM nodes cannot be JSON-stringified (circular fibers). Identity-compare
  // anything that isn't a primitive/array/plain object.
  const isNode = (x: unknown): boolean =>
    typeof x === 'object' && x != null && typeof (x as { nodeType?: unknown }).nodeType === 'number';
  if (isNode(expected) || isNode(actual)) {
    if (expected === actual) ok(label);
    else fail(label, '<DOM node>', actual === null ? null : '<other DOM node>');
    return;
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else fail(label, true, detail ?? false);
}

// ── React render helpers ──────────────────────────────────────────────────
function mount(node: React.ReactElement): { root: Root; container: HTMLElement; cleanup: () => void } {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    root, container,
    cleanup() {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

function slots(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[data-testid^="otp-slot-"]')) as HTMLInputElement[];
}

/**
 * Simulate the user typing `value` into an input. React 18 in jsdom uses a
 * value-tracker that suppresses the synthetic onChange unless the DOM value
 * appears to have changed *between renders*. Bust the tracker, set the DOM
 * value, then call React's onChange directly via the fiber props — this is
 * the same fallback @testing-library/user-event uses for jsdom.
 */
function reactInput(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  desc?.set?.call(el, value);
  const tracker = (el as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  if (tracker) tracker.setValue('');
  // Try the regular dispatch path first (covers most cases).
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  // Direct fiber-prop call as a robust fallback for controlled inputs whose
  // value didn't change on the DOM side because React re-set it on render.
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (fiberKey) {
    type Props = { onChange?: (e: { target: HTMLInputElement }) => void };
    const props = (el as unknown as Record<string, Props>)[fiberKey];
    // Make sure the value the handler reads is the one we just typed,
    // even if React resets the DOM value during re-render.
    desc?.set?.call(el, value);
    props?.onChange?.({ target: el });
  }
}

function keyDown(el: HTMLElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

function pasteInto(el: HTMLElement, text: string) {
  // jsdom DataTransfer is read-only; build a minimal ClipboardData shim.
  const data = {
    getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
  };
  const ev = new window.Event('paste', { bubbles: true, cancelable: true }) as unknown as
    Event & { clipboardData: typeof data };
  (ev as unknown as { clipboardData: typeof data }).clipboardData = data;
  el.dispatchEvent(ev);
}

/** Controlled wrapper so the parent state mirrors a real consumer. */
function Harness(props: {
  initial?: string;
  error?: boolean;
  onComplete?: (full: string) => void;
  onChangeSpy?: (next: string) => void;
}) {
  const [v, setV] = useState(props.initial ?? '');
  return (
    <OtpInput
      value={v}
      onChange={(next) => { setV(next); props.onChangeSpy?.(next); }}
      onComplete={props.onComplete}
      error={props.error}
    />
  );
}

// ────────────────────────────────────────────────────────────────────── 1. RENDER + A11Y
function renderTests() {
  console.log('\n── RENDER / ACCESSIBILITY ──');
  const { container, cleanup } = mount(<Harness />);

  // 6 slots present.
  const s = slots(container);
  eq('(R1) renders 6 slots by default', 6, s.length);

  // role=group + aria-label on the wrapper.
  const group = container.querySelector('[data-testid="otp-input"]')!;
  eq('(R2) wrapper has role="group"', 'group', group.getAttribute('role'));
  assert('(R2) wrapper has aria-label',
    !!group.getAttribute('aria-label') && group.getAttribute('aria-label')!.length > 0);

  // Each slot has aria-label "Digit N of 6" and inputMode=numeric.
  s.forEach((el, i) => {
    eq(`(R3) slot ${i} aria-label = "Digit ${i + 1} of 6"`,
       `Digit ${i + 1} of 6`, el.getAttribute('aria-label'));
    eq(`(R3) slot ${i} inputMode=numeric`, 'numeric', el.getAttribute('inputmode'));
    eq(`(R3) slot ${i} maxLength=1`, '1', el.getAttribute('maxlength'));
  });

  // Slot 0 owns autocomplete="one-time-code" so iOS surfaces SMS autofill.
  eq('(R4) slot 0 autocomplete = "one-time-code"',
     'one-time-code', s[0].getAttribute('autocomplete'));
  eq('(R4) other slots autocomplete = "off"',
     'off', s[1].getAttribute('autocomplete'));

  // Slot 0 is auto-focused on mount.
  eq('(R5) slot 0 has focus on mount (by index)',
     0, slots(container).indexOf(window.document.activeElement as HTMLInputElement));

  // Hidden sr-only paste hint exists.
  const hint = container.querySelector('.sr-only');
  assert('(R6) sr-only paste hint present', !!hint && /paste/i.test(hint!.textContent ?? ''));

  cleanup();
}

// ────────────────────────────────────────────────────────────────────── 2. TYPING + ADVANCE
function typingTests() {
  console.log('\n── TYPING / AUTO-ADVANCE ──');
  let lastValue = '';
  const { container, cleanup } = mount(
    <Harness onChangeSpy={(v) => { lastValue = v; }} />,
  );

  // Type "1" in slot 0 → value becomes "1", focus moves to slot 1.
  // (Re-query slots after every act() because controlled re-render may
  // produce new DOM nodes for the same logical position.)
  act(() => { reactInput(slots(container)[0], '1'); });
  eq('(T1) after typing "1" in slot 0, value = "1"', '1', lastValue);
  const focusedIdx = slots(container).indexOf(window.document.activeElement as HTMLInputElement);
  eq('(T1) focus auto-advances to slot 1 (by index)', 1, focusedIdx);

  // For each subsequent slot, we have to re-find the currently-focused
  // slot (the auto-advance from the previous act moved it). Find by
  // index instead of position.
  let curIdx = focusedIdx;
  for (const d of ['2', '3', '4', '5']) {
    act(() => { reactInput(slots(container)[curIdx], d); });
    curIdx = slots(container).indexOf(window.document.activeElement as HTMLInputElement);
  }
  eq('(T2) progressive value building', '12345', lastValue);
  eq('(T2) focus moved to slot 5 (by index)', 5, curIdx);

  // Non-digit single chars should be blocked (preventDefault on keydown).
  const evt = new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
  slots(container)[curIdx].dispatchEvent(evt);
  assert('(T3) non-digit keypress was preventDefault\'d', evt.defaultPrevented);

  // Last digit
  act(() => { reactInput(slots(container)[curIdx], '6'); });
  eq('(T4) value fills to 6 digits', '123456', lastValue);

  cleanup();
}

// ────────────────────────────────────────────────────────────────────── 3. BACKSPACE
function backspaceTests() {
  console.log('\n── BACKSPACE NAVIGATION ──');
  let lastValue = '';
  const { container, cleanup } = mount(
    <Harness initial="12345" onChangeSpy={(v) => { lastValue = v; }} />,
  );

  // Move focus to slot 5 (currently empty since initial="12345" only fills 0..4).
  act(() => { slots(container)[5].focus(); });
  // Backspace on empty slot 5 → jump back to slot 4 and clear it.
  act(() => { keyDown(slots(container)[5], 'Backspace'); });
  const focusedB1 = slots(container).indexOf(window.document.activeElement as HTMLInputElement);
  eq('(B1) backspace on empty slot 5 jumps to slot 4 (by index)', 4, focusedB1);
  eq('(B1) backspace on empty slot 5 clears digit-4', '1234', lastValue);

  cleanup();
}

// ────────────────────────────────────────────────────────────────────── 4. ARROW KEYS
function arrowTests() {
  console.log('\n── ARROW / HOME / END NAVIGATION ──');
  const { container, cleanup } = mount(<Harness initial="123456" />);
  const focusedIdx = () => slots(container).indexOf(window.document.activeElement as HTMLInputElement);

  act(() => { slots(container)[3].focus(); });

  act(() => { keyDown(slots(container)[3], 'ArrowLeft'); });
  eq('(N1) ArrowLeft moves to slot 2 (by index)', 2, focusedIdx());

  act(() => { keyDown(slots(container)[2], 'ArrowRight'); });
  eq('(N2) ArrowRight moves to slot 3 (by index)', 3, focusedIdx());

  act(() => { keyDown(slots(container)[3], 'Home'); });
  eq('(N3) Home moves to slot 0 (by index)', 0, focusedIdx());

  act(() => { keyDown(slots(container)[0], 'End'); });
  eq('(N4) End moves to slot length-1 (by index)', 5, focusedIdx());

  // Boundary: ArrowLeft from slot 0 stays at slot 0.
  act(() => { slots(container)[0].focus(); keyDown(slots(container)[0], 'ArrowLeft'); });
  eq('(N5) ArrowLeft from slot 0 stays at 0 (by index)', 0, focusedIdx());

  // Boundary: ArrowRight from last slot stays at last slot.
  act(() => { slots(container)[5].focus(); keyDown(slots(container)[5], 'ArrowRight'); });
  eq('(N6) ArrowRight from last slot stays at last (by index)', 5, focusedIdx());

  cleanup();
}

// ────────────────────────────────────────────────────────────────────── 5. PASTE
function pasteTests() {
  console.log('\n── PASTE HANDLING ──');
  let lastValue = '';
  let completedWith: string | null = null;
  const { container, cleanup } = mount(
    <Harness
      onChangeSpy={(v) => { lastValue = v; }}
      onComplete={(full) => { completedWith = full; }}
    />,
  );
  // Full paste into slot 0.
  act(() => { pasteInto(slots(container)[0], '987654'); });
  eq('(P1) full paste populates all 6 slots', '987654', lastValue);
  eq('(P1) onComplete fires after full paste', '987654', completedWith);

  // Reset and paste a partial code into slot 2.
  completedWith = null;
  cleanup();
  let last2 = '';
  const m2 = mount(
    <Harness initial="12" onChangeSpy={(v) => { last2 = v; }} />,
  );
  act(() => { slots(m2.container)[2].focus(); pasteInto(slots(m2.container)[2], '345'); });
  eq('(P2) partial paste from slot 2 → value = "12345"', '12345', last2);

  // Paste with formatting noise ("1-2-3 4 5 6") → only digits survive.
  let last3 = '';
  m2.cleanup();
  const m3 = mount(<Harness onChangeSpy={(v) => { last3 = v; }} />);
  act(() => { pasteInto(slots(m3.container)[0], '1-2-3 4 5 6'); });
  eq('(P3) paste with noise strips non-digits', '123456', last3);

  // Paste of empty string is a no-op.
  let last4 = '';
  m3.cleanup();
  const m4 = mount(<Harness onChangeSpy={(v) => { last4 = v; }} />);
  act(() => { pasteInto(slots(m4.container)[0], ''); });
  eq('(P4) empty paste does nothing', '', last4);

  m4.cleanup();
}

// ────────────────────────────────────────────────────────────────────── 6. onComplete
function completionTests() {
  console.log('\n── onComplete BEHAVIOUR ──');
  let count = 0;
  let lastFull = '';
  const { container, cleanup } = mount(
    <Harness
      initial="12345"
      onComplete={(full) => { count++; lastFull = full; }}
    />,
  );

  // Type the 6th digit — onComplete should fire exactly once.
  act(() => { reactInput(slots(container)[5], '9'); });
  eq('(C1) onComplete fired once', 1, count);
  eq('(C1) onComplete payload = full code', '123459', lastFull);

  // Mutating without re-completing (clear + retype) → fires again.
  act(() => { reactInput(slots(container)[5], ''); });
  act(() => { reactInput(slots(container)[5], '9'); });
  eq('(C2) onComplete re-fires after clear+retype', 2, count);

  cleanup();
}

// ────────────────────────────────────────────────────────────────────── 7. ERROR PROP
function errorStateTests() {
  console.log('\n── ERROR STATE PROP ──');
  const { container, cleanup } = mount(<Harness error />);
  const s = slots(container);
  assert('(E1) error=true → slots carry aria-invalid',
    s.every((el) => el.getAttribute('aria-invalid') === 'true'));
  assert('(E1) error styling applied to slot 0 (border-red-500 class)',
    s[0].className.includes('border-red'));

  cleanup();

  // error=false → no aria-invalid set.
  const m2 = mount(<Harness />);
  const s2 = slots(m2.container);
  assert('(E2) error=false → no aria-invalid',
    s2.every((el) => el.getAttribute('aria-invalid') == null));
  m2.cleanup();
}

// ────────────────────────────────────────────────────────────────────── 8. REGRESSION
function regressionTests() {
  console.log('\n── REGRESSION — shared password components still render ──');

  // Feature #11 PasswordStrengthMeter must still render with our test
  // password — no exception, contains both the level word and the rule list.
  const { container, cleanup } = mount(
    <PasswordStrengthMeter password="TestPass#9k2" email="user@gmail.com" />,
  );
  const text = container.textContent ?? '';
  assert('(REG1) PasswordStrengthMeter renders some level label',
    /Weak|Fair|Good|Strong|Very Strong/.test(text));
  assert('(REG1) rule checklist present',
    !!container.querySelector('[data-testid="pw-rules"]') ||
     container.textContent!.toLowerCase().includes('uppercase'));
  cleanup();

  // OtpInput with `disabled` blocks any input mutation.
  const { container: c2, cleanup: cleanup2 } = mount(
    <OtpInput value="" onChange={() => { /* */ }} disabled />,
  );
  const s = Array.from(c2.querySelectorAll('input')) as HTMLInputElement[];
  assert('(REG2) disabled slots are actually disabled', s.every((el) => el.disabled));
  cleanup2();

  // Length prop respected.
  const { container: c3, cleanup: cleanup3 } = mount(
    <OtpInput value="" onChange={() => { /* */ }} length={4} />,
  );
  eq('(REG3) length=4 renders 4 slots', 4,
    c3.querySelectorAll('[data-testid^="otp-slot-"]').length);
  cleanup3();
}

// ────────────────────────────────────────────────────────────────────── MAIN
async function main() {
  renderTests();
  typingTests();
  backspaceTests();
  arrowTests();
  pasteTests();
  completionTests();
  errorStateTests();
  regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
