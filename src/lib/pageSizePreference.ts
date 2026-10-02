/**
 * Page-size preference cookie — Item 12 Phase 2.
 *
 *   sc_ps_<scope>  — e.g. `sc_ps_admin_orders=50`. One cookie per
 *                    paginated surface so an admin's preference on
 *                    /admin/orders doesn't override the storefront's.
 *
 * Pure module (no React import). Defensive against any environment
 * (SSR, Edge, tests) — `document` access is guarded.
 *
 *   readPageSizePreference('admin_orders', defaultSize=20)
 *   writePageSizePreference('admin_orders', 50)
 *
 * The value is clamped to a sane range on read; invalid stored
 * values are ignored (returns the supplied default).
 */
const COOKIE_PREFIX = 'sc_ps_';
const ONE_YEAR_SEC  = 60 * 60 * 24 * 365;

/** SameSite=Lax so prefs survive nav from external links. */
const COOKIE_FLAGS = `Path=/; Max-Age=${ONE_YEAR_SEC}; SameSite=Lax`;

function safeScope(scope: string): string {
  return scope.replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
}

export function readPageSizePreference(scope: string, defaultSize: number, maxSize = 1000): number {
  if (typeof document === 'undefined') return defaultSize;
  const key = COOKIE_PREFIX + safeScope(scope);
  const pairs = document.cookie ? document.cookie.split(';') : [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k !== key) continue;
    const v = p.slice(eq + 1).trim();
    if (!/^\d+$/.test(v)) return defaultSize;
    const n = Number(v);
    if (n < 1 || n > maxSize) return defaultSize;
    return n;
  }
  return defaultSize;
}

export function writePageSizePreference(scope: string, size: number): void {
  if (typeof document === 'undefined') return;
  if (!Number.isFinite(size) || size < 1) return;
  const key = COOKIE_PREFIX + safeScope(scope);
  document.cookie = `${key}=${Math.floor(size)}; ${COOKIE_FLAGS}`;
}
