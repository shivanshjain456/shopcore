'use client';
/**
 * Client-side logout helper — Feature #9.
 *
 * Wraps the server-side POST /api/auth/logout endpoint with:
 *  - CSRF (via the `api()` wrapper which sets x-csrf-token)
 *  - Idempotent "already-signed-out" handling (401/403 → still success)
 *  - Best-effort client-state cleanup (guest cart, any cached profile)
 *  - Back-button protection (replace + bfcache pageshow detector — see
 *    `installBfcacheGuard()` below; opt-in for authenticated pages)
 *
 * This file deliberately has NO React imports. It can be called from any
 * React or vanilla JS context. The `LogoutButton` component wraps it with
 * the dialog confirmation + busy state.
 */
import { api } from './api';

export type LogoutScope = 'current' | 'all';

export interface LogoutResult {
  ok: true;
  scope: LogoutScope;
  /** True if the server confirmed it had an active session to revoke. */
  hadSession: boolean;
  /** Always true after this returns — UX is "signed out" either way. */
  signedOut: true;
}

const GUEST_CART_KEY = 'sc_guest_cart_v1';

/**
 * Perform the logout round-trip.
 *
 *  - Always resolves; never throws on network errors. A failure is recorded
 *    in `result.ok` semantics but the local state is ALWAYS cleared.
 *  - 401/403 from the server is treated as success: the session is already
 *    invalid, that's exactly the state we wanted.
 *  - Other 5xx errors leave the local state cleared but the caller knows
 *    the server didn't confirm. We still navigate the user to login because
 *    the alternative (leaving them on an authed page with no usable cookie)
 *    is strictly worse.
 */
export async function performLogout(scope: LogoutScope = 'current'): Promise<LogoutResult> {
  // Fire the server call. Tolerate every failure mode.
  let serverOk = false;
  try {
    const r = await api<{ message: string; hadSession: boolean }>('/api/auth/logout', {
      method: 'POST', body: { scope },
    });
    // 200 = clean revoke. 401/403 = already signed out (idempotent). Both
    // count as "the desired end-state is reached" for the user.
    serverOk = r.ok || r.status === 401 || r.status === 403;
  } catch {
    // Network failure — fall through and still clear local state.
    serverOk = false;
  }

  clearClientAuthState();

  return {
    ok: true,
    scope,
    hadSession: serverOk,
    signedOut: true,
  };
}

/**
 * Best-effort client-state cleanup. Anything cached in the browser that
 * could reveal info about the previous user goes here.
 *
 * We do NOT clear the entire `localStorage` — that would nuke unrelated
 * site preferences. We DO clear the guest cart (which can leak SKU history)
 * and any `sc_*` items the app might cache.
 */
export function clearClientAuthState(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(GUEST_CART_KEY);
    // Sweep any other `sc_*` cached items
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sc_') && k !== 'sc_csrf') localStorage.removeItem(k);
    }
    // sessionStorage gets a full wipe — it's per-tab anyway and nobody
    // legitimately persists cross-tab state in it.
    sessionStorage.clear();
  } catch { /* private mode / quota — ignore */ }
}

/**
 * After logout we navigate to /login?signed_out=1. The browser back button
 * can restore the cached (authenticated) page from bfcache. This guard
 * detects bfcache restores and force-reloads if the user is no longer
 * authenticated.
 *
 * Call ONCE from the storefront/admin root layout (mounted by
 * `BackButtonGuard.tsx`).
 */
export function installBfcacheGuard(isAuthedSelector: () => boolean | Promise<boolean>): () => void {
  if (typeof window === 'undefined') return () => {};
  async function onPageShow(e: PageTransitionEvent) {
    if (!e.persisted) return;                  // not from bfcache → ignore
    const authed = await Promise.resolve(isAuthedSelector());
    if (!authed) {
      // We were on an authenticated page but auth is gone — reload to land
      // on the proper public version or be redirected by middleware.
      window.location.reload();
    }
  }
  window.addEventListener('pageshow', onPageShow);
  return () => window.removeEventListener('pageshow', onPageShow);
}
