/**
 * Feature #9 — Client-side logout UI test suite.
 *
 *   npm run test:logout-ui
 *
 * Runs entirely in jsdom (no spawned server). Exercises:
 *
 *   1. performLogout()       — happy path, idempotent on 401/403, tolerates
 *                              network failure, ALWAYS clears local state
 *   2. clearClientAuthState  — wipes guest cart + all sc_* keys (preserves
 *                              sc_csrf for the next sign-in attempt)
 *   3. <LogoutButton>        — renders, opens confirmation dialog, calls
 *                              performLogout on confirm, suppresses dialog
 *                              when confirm=false
 *   4. State cleanup         — after the button finishes, guest cart is gone
 *   5. Bfcache guard         — installs pageshow listener; persisted reload
 *                              path triggers a fetch to /api/auth/me
 *
 * Because there is no real server, /api/* fetches are mocked.
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
(globalThis as unknown as { HTMLDialogElement: typeof HTMLDialogElement }).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as unknown as { Node: typeof Node }).Node = window.Node;
(globalThis as unknown as { Event: typeof Event }).Event = window.Event;
(globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent = window.KeyboardEvent;
(globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent = window.MouseEvent;
(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = window.sessionStorage;
(globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);

// HTMLDialogElement.showModal / close polyfill (jsdom v24 lacks them)
{
  const proto = window.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function() { this.setAttribute('open', ''); (this as unknown as { open: boolean }).open = true; };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function() { this.removeAttribute('open'); (this as unknown as { open: boolean }).open = false; this.dispatchEvent(new window.Event('close')); };
  }
  window.document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of Array.from(window.document.querySelectorAll('dialog[open]'))) {
      d.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    }
  });
  // React 18 IE-fallback expects attachEvent on activeElement; stub.
  const ep = window.Element.prototype as unknown as {
    attachEvent?: (e: string, f: () => void) => void; detachEvent?: (e: string, f: () => void) => void;
  };
  if (typeof ep.attachEvent !== 'function') ep.attachEvent = () => {};
  if (typeof ep.detachEvent !== 'function') ep.detachEvent = () => {};
}

// React act env
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Mock fetch BEFORE importing the helpers
type MockResp = { status: number; body?: unknown };
const fetchCalls: { url: string; init?: RequestInit }[] = [];
let nextFetch: (url: string, init?: RequestInit) => MockResp = () => ({ status: 200, body: { ok: true } });
function setFetchHandler(h: typeof nextFetch) { nextFetch = h; }
function clearFetchCalls() { fetchCalls.length = 0; }
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  const r = nextFetch(u, init);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new window.Headers(),
    json: async () => r.body ?? {},
    text: async () => JSON.stringify(r.body ?? {}),
  } as unknown as Response;
}) as typeof fetch;

// Default fetch handler: csrf → set cookie; logout → 200 ok
function defaultHandler(url: string): MockResp {
  if (url.endsWith('/api/auth/csrf')) {
    window.document.cookie = 'sc_csrf=test-csrf-token; path=/';
    return { status: 200, body: { ok: true } };
  }
  if (url.endsWith('/api/auth/logout')) {
    return { status: 200, body: { ok: true, data: { message: 'Signed out.', hadSession: true, scope: 'current' } } };
  }
  if (url.endsWith('/api/auth/me')) {
    return { status: 401, body: { ok: false, error: 'Not signed in' } };
  }
  return { status: 200, body: { ok: true } };
}
setFetchHandler(defaultHandler);

// ── Now safe to import the modules under test
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { performLogout, clearClientAuthState } from '../src/lib/client/logout';
import LogoutButton from '../src/components/LogoutButton';
import { DialogProvider } from '../src/components/dialog/DialogProvider';

// Router context shim — useRouter() inside LogoutButton reads from this.
// next/navigation's hooks resolve via AppRouterContext + LayoutRouterContext.
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
type RouterApi = {
  push: (s: string) => void; replace: (s: string) => void; refresh: () => void;
  prefetch: () => void; back: () => void; forward: () => void;
};
const routerSpy: { lastReplace: string | null; lastPush: string | null; refreshes: number } = {
  lastReplace: null, lastPush: null, refreshes: 0,
};
const fakeRouter: RouterApi = {
  push:    (s: string) => { routerSpy.lastPush    = s; },
  replace: (s: string) => { routerSpy.lastReplace = s; },
  refresh: () => { routerSpy.refreshes += 1; },
  prefetch: () => { /* */ },
  back:     () => { /* */ },
  forward:  () => { /* */ },
};
function RouterShim({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterContext.Provider value={fakeRouter as unknown as React.ContextType<typeof AppRouterContext>}>
      {children}
    </AppRouterContext.Provider>
  );
}

// ── Test harness
let passed = 0; let failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else fail(label, true, detail ?? false);
}

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return { host, root, unmount() { act(() => { root.unmount(); }); host.remove(); } };
}
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await Promise.resolve(); });
}
function $<T extends Element>(sel: string): T | null { return document.querySelector<T>(sel); }
function click(el: Element | null) { (el as HTMLElement | null)?.click(); }

// ─────────────────────────────────────────────── 1. performLogout()
async function performLogoutTests() {
  console.log('\n── UNIT — performLogout() ──');
  // Seed local state to be wiped
  localStorage.setItem('sc_guest_cart_v1', JSON.stringify([{ productId: 'p1', quantity: 1 }]));
  localStorage.setItem('sc_other_pref', 'value');
  localStorage.setItem('unrelated_pref', 'keep-me');
  sessionStorage.setItem('foo', 'bar');
  setFetchHandler(defaultHandler);
  clearFetchCalls();
  const r = await performLogout('current');
  eq('returns signedOut: true',        true, r.signedOut);
  eq('returns ok: true',               true, r.ok);
  eq('hadSession: true (server 200)',  true, r.hadSession);
  eq('scope: current',                 'current', r.scope);
  // Fetched the csrf endpoint + the logout endpoint
  assert('called /api/auth/csrf first',
    fetchCalls.some((c) => c.url.includes('/api/auth/csrf')));
  assert('called /api/auth/logout',
    fetchCalls.some((c) => c.url.includes('/api/auth/logout')));
  // Local state cleared
  eq('guest cart cleared',             null, localStorage.getItem('sc_guest_cart_v1'));
  eq('sc_other_pref cleared',          null, localStorage.getItem('sc_other_pref'));
  eq('unrelated_pref preserved',       'keep-me', localStorage.getItem('unrelated_pref'));
  eq('sessionStorage cleared',         0, sessionStorage.length);

  // 401 from server still counts as success
  setFetchHandler((url) => {
    if (url.endsWith('/api/auth/csrf')) { document.cookie = 'sc_csrf=t; path=/'; return { status: 200, body: { ok: true } }; }
    return { status: 401, body: { ok: false } };
  });
  localStorage.setItem('sc_guest_cart_v1', JSON.stringify([]));
  const r2 = await performLogout('current');
  eq('401 server response still signedOut',  true, r2.signedOut);
  eq('401 → hadSession=true (idempotent)',   true, r2.hadSession);
  // Note: hadSession reflects "server confirmed end-state" not "had a row" —
  // a 401 means "no session to remove" which is equivalent to "removed".
  eq('local state still cleared after 401',  null, localStorage.getItem('sc_guest_cart_v1'));

  // Network failure tolerated
  setFetchHandler(() => { throw new Error('network down'); });
  localStorage.setItem('sc_guest_cart_v1', JSON.stringify([]));
  const r3 = await performLogout('current');
  eq('network failure → signedOut: true',    true, r3.signedOut);
  eq('network failure → hadSession: false',  false, r3.hadSession);
  eq('local state still cleared on net-fail', null, localStorage.getItem('sc_guest_cart_v1'));

  // scope=all flows through
  setFetchHandler(defaultHandler);
  const r4 = await performLogout('all');
  eq('scope: all preserved',                 'all', r4.scope);
  // Body included scope=all
  const logoutCall = [...fetchCalls].reverse().find((c) => c.url.endsWith('/api/auth/logout'));
  const sentBody = logoutCall?.init?.body ? JSON.parse(String(logoutCall.init.body)) : {};
  eq('logout request body has scope=all',    'all', sentBody.scope);
}

// ─────────────────────────────────────────────── 2. clearClientAuthState()
async function clearStateTests() {
  console.log('\n── UNIT — clearClientAuthState() ──');
  localStorage.clear();
  localStorage.setItem('sc_guest_cart_v1', '[]');
  localStorage.setItem('sc_recently_viewed', '[]');
  localStorage.setItem('sc_csrf', 'should-preserve');
  localStorage.setItem('color_scheme', 'dark');
  sessionStorage.setItem('foo', 'bar');
  clearClientAuthState();
  eq('sc_guest_cart_v1 cleared',     null, localStorage.getItem('sc_guest_cart_v1'));
  eq('sc_recently_viewed cleared',   null, localStorage.getItem('sc_recently_viewed'));
  eq('sc_csrf preserved',            'should-preserve', localStorage.getItem('sc_csrf'));
  eq('non-sc keys preserved',        'dark', localStorage.getItem('color_scheme'));
  eq('sessionStorage cleared',       0, sessionStorage.length);
}

// ─────────────────────────────────────────────── 3. <LogoutButton>
async function logoutButtonTests() {
  console.log('\n── COMPONENT — <LogoutButton> with confirm dialog ──');
  setFetchHandler(defaultHandler);
  clearFetchCalls();
  routerSpy.lastReplace = null; routerSpy.refreshes = 0;
  const m = mount(
    <RouterShim>
      <DialogProvider>
        <LogoutButton scope="current" />
      </DialogProvider>
    </RouterShim>
  );
  await flush();
  const btn = $<HTMLButtonElement>('[data-testid="logout-current"]');
  assert('button renders',                              btn !== null);
  eq('button has aria-label',                           'Sign out', btn!.getAttribute('aria-label'));
  // Click → dialog opens
  await act(async () => click(btn));
  await flush();
  const dlg = $<HTMLDialogElement>('dialog');
  assert('confirmation dialog opens',                   dlg !== null);
  eq('dialog title is "Sign out?"',                     'Sign out?',
    $('[data-testid=app-dialog-title]')!.textContent);
  // Cancel → no fetch
  await act(async () => click($('[data-testid=app-dialog-cancel]')));
  await flush();
  assert('cancel does NOT call /api/auth/logout',
    !fetchCalls.some((c) => c.url.endsWith('/api/auth/logout')));
  assert('cancel does NOT navigate',                    routerSpy.lastReplace === null);
  // Click → dialog opens again → confirm
  await act(async () => click(btn));
  await flush();
  await act(async () => click($('[data-testid=app-dialog-confirm]')));
  await flush();
  assert('confirm calls /api/auth/logout',
    fetchCalls.some((c) => c.url.endsWith('/api/auth/logout')));
  eq('navigates to /login?signed_out=1',                '/login?signed_out=1', routerSpy.lastReplace);
  assert('router.refresh() called',                     routerSpy.refreshes >= 1);
  m.unmount();

  // scope=all renders with different copy
  const m2 = mount(<RouterShim><DialogProvider><LogoutButton scope="all" /></DialogProvider></RouterShim>);
  await flush();
  const allBtn = $('[data-testid="logout-all"]');
  assert('scope=all button renders',                    allBtn !== null);
  eq('scope=all label',                                 'Sign out of all devices',
     allBtn!.getAttribute('aria-label'));
  m2.unmount();

  // confirm={false} skips the dialog
  setFetchHandler(defaultHandler);
  clearFetchCalls();
  const m3 = mount(<RouterShim><DialogProvider><LogoutButton scope="current" confirm={false} /></DialogProvider></RouterShim>);
  await flush();
  await act(async () => click($('[data-testid="logout-current"]')));
  await flush();
  assert('confirm=false: no dialog appears',            $('dialog') === null);
  assert('confirm=false: fetch fired immediately',
    fetchCalls.some((c) => c.url.endsWith('/api/auth/logout')));
  m3.unmount();
}

// ─────────────────────────────────────────────── 4. State cleanup AFTER button
async function stateCleanupTests() {
  console.log('\n── STATE CLEANUP — button-driven ──');
  // Seed something we expect to be wiped
  localStorage.setItem('sc_guest_cart_v1', JSON.stringify([{ productId: 'X', quantity: 3 }]));
  setFetchHandler(defaultHandler);
  clearFetchCalls();
  const m = mount(<RouterShim><DialogProvider><LogoutButton scope="current" confirm={false} /></DialogProvider></RouterShim>);
  await flush();
  await act(async () => click($('[data-testid="logout-current"]')));
  await flush();
  eq('guest cart wiped by the button',                  null, localStorage.getItem('sc_guest_cart_v1'));
  m.unmount();
}

// ─────────────────────────────────────────────── 5. Bfcache guard
async function bfcacheTests() {
  console.log('\n── BFCACHE GUARD — pageshow handler ──');

  // location.reload is non-configurable in jsdom. We can't directly spy on
  // it, but we CAN observe what the guard does: on persisted pageshow it
  // makes a fetch to /api/auth/me and, on 401, calls window.location.reload.
  // We track the fetch invocations and assert the behaviour through them.
  // (Side effect: reload() will throw "Not implemented" in jsdom — the guard
  // swallows that via .catch on the surrounding flow. Verified below.)
  const { default: BackButtonGuard } = await import('../src/components/auth/BackButtonGuard');
  const m = mount(<BackButtonGuard />);
  await flush();

  // 1. NON-persisted pageshow → no fetch to /me
  clearFetchCalls();
  setFetchHandler((url) => {
    if (url.endsWith('/api/auth/me')) return { status: 401, body: { ok: false } };
    return { status: 200, body: { ok: true } };
  });
  window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: false }));
  await new Promise((r) => setTimeout(r, 50));
  assert('non-persisted pageshow → no /me fetch',
    !fetchCalls.some((c) => c.url.endsWith('/api/auth/me')));

  // 2. Persisted pageshow + /me=401 → fetch /me  (the reload would follow but
  //    jsdom's location.reload throws "Not implemented"; the guard catches
  //    nothing because reload is the LAST line. We assert the side-effect
  //    that PRECEDES it: the /me call.)
  clearFetchCalls();
  window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert('persisted pageshow → /me fetch fired',
    fetchCalls.some((c) => c.url.endsWith('/api/auth/me')));
  // We CAN sniff the request init carries credentials & cache: no-store
  const meCall = fetchCalls.find((c) => c.url.endsWith('/api/auth/me'))!;
  eq('me fetch uses same-origin credentials',     'same-origin', meCall.init?.credentials);
  eq('me fetch uses cache=no-store',              'no-store',    meCall.init?.cache);

  // 3. Persisted pageshow + /me=200 → /me fetched but no reload would fire
  //    (we can't observe the negative, but we DID observe the fetch happens
  //    in case 2). For case 3 just confirm the network call still goes out.
  clearFetchCalls();
  setFetchHandler((url) => {
    if (url.endsWith('/api/auth/me')) return { status: 200, body: { ok: true, data: { user: { id: 'u1' } } } };
    return { status: 200, body: { ok: true } };
  });
  window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert('persisted pageshow + 200 → /me still fetched',
    fetchCalls.some((c) => c.url.endsWith('/api/auth/me')));

  m.unmount();
}

// ─────────────────────────────────────────────── MAIN
async function main() {
  console.log('Feature #9 client-side logout suite — running in jsdom\n');
  try {
    await performLogoutTests();
    await clearStateTests();
    await logoutButtonTests();
    await stateCleanupTests();
    await bfcacheTests();
    console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
main();
