'use client';
/**
 * BackButtonGuard — Feature #9.
 *
 * Mounted once in the storefront + admin root layouts. Detects when the
 * browser restores the page from bfcache (Safari/Firefox `pageshow` with
 * `persisted: true`) AFTER a logout has cleared cookies, and force-reloads
 * so the user lands on the public version instead of the cached authed UI.
 *
 * Detection strategy:
 *   - We don't try to read cookies from JS (they're HttpOnly). Instead we
 *     hit /api/auth/me with `credentials: same-origin` — fast (it short-
 *     circuits to 401 when no cookie). If the page was rendered as authed
 *     but /me now says 401, we reload.
 *
 * Cost: one fetch per back-navigation. The endpoint is already on the hot
 * path so it stays warm.
 */
import { useEffect } from 'react';

export default function BackButtonGuard() {
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (!e.persisted) return;
      // We were restored from bfcache. Ask the server if we still have a
      // session; if not, reload to drop any stale authed UI.
      void fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => {
          if (r.status === 401) {
            window.location.reload();
          }
        })
        .catch(() => { /* network error — leave as-is, next interaction will hit auth */ });
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  return null;
}
