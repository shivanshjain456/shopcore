/**
 * Next.js middleware (runs at the edge for every matched request):
 *  - Applies baseline security headers (CSP/HSTS/X-Frame/etc. are layered here
 *    AND in next.config.mjs — middleware wins for runtime-set values).
 *  - Adds a request-id and surfaces it in the response (`x-request-id`) so log
 *    lines + browser DevTools can be cross-referenced.
 *  - Enforces role-based gates on /admin, /account, /b2b (light cookie-presence
 *    check; full verification still happens server-side in route handlers).
 *  - Cookies marked Secure in production by middleware-aware downstream code.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { decodeJwt } from 'jose';
import { SECURITY_HEADERS } from '@/lib/security/headers';

const SESSION_COOKIE = 'sc_session';
const ADMIN_COOKIE = 'sc_admin';

/** Paths a PENDING_PHONE_VERIFICATION user is allowed to access without
 *  redirect. Everything else under `/account|/checkout|/cart|...` bounces
 *  to `/verify-phone`. We are deliberately conservative — public
 *  storefront routes (/, /p, /c, /search) pass through always; the gate
 *  only fires for known authed surfaces. */
const PHONE_PENDING_ALLOWED_PREFIXES = [
  '/verify-phone',
  '/api/auth/phone/',
  '/api/auth/csrf',
  '/api/auth/logout',
  '/api/auth/logout-all',
  '/api/auth/logout-others',
  '/api/auth/me',
  '/api/auth/refresh',
  '/logout',
  '/_next/',
  '/favicon',
];

/** Authed surfaces the gate guards. Mirrors the protected matcher below. */
const PHONE_PENDING_PROTECTED_PREFIXES = [
  '/account',
  '/checkout',
  '/cart',
  '/orders',
  '/wishlist',
  '/b2b/dashboard',
  '/b2b/quotes',
  '/b2b/bulk',
];

/** Read the `status` claim from a session JWT WITHOUT verifying the
 *  signature. Used for routing only — security still lives in route
 *  handlers which call `getCurrentUser` against the DB. Returns `null`
 *  when decode fails for any reason. */
function readStatusClaim(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = decodeJwt(token) as { status?: unknown };
    return typeof payload.status === 'string' ? payload.status : null;
  } catch { return null; }
}

function genRequestId(): string {
  // 12 hex chars — collision-free enough for log correlation
  const a = Math.random().toString(16).slice(2, 10);
  const b = Math.random().toString(16).slice(2, 6);
  return a + b;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Security: NEVER honour an incoming `x-request-id` from the network.
  // An attacker who controls it could inject a value that collides
  // with a legitimate user's request id in our logs, frustrating
  // forensics. We always generate a fresh id and OVERWRITE any
  // inbound header before propagation. The handler-side logger reads
  // this overwritten value, so downstream log lines all carry the
  // server-controlled correlation id.
  const reqId = genRequestId();

  // Rebuild the inbound headers so the request that reaches the route
  // handler also sees the overwritten value (NextResponse.next forwards
  // request headers when constructed with `{ request: { headers } }`).
  const fwd = new Headers(req.headers);
  fwd.set('x-request-id', reqId);
  const res = NextResponse.next({ request: { headers: fwd } });

  // Propagate request-id back to the client and into route-handler logs
  res.headers.set('x-request-id', reqId);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }

  // /admin (except /admin/login) requires admin cookie
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    const adminCookie = req.cookies.get(ADMIN_COOKIE);
    if (!adminCookie) {
      const url = req.nextUrl.clone();
      url.pathname = '/admin/login';
      url.searchParams.set('next', pathname);
      const r = NextResponse.redirect(url);
      r.headers.set('x-request-id', reqId);
      return r;
    }
  }

  // /account and /b2b authed surface require regular session cookie
  if (pathname.startsWith('/account') || pathname.startsWith('/b2b/dashboard')
      || pathname.startsWith('/b2b/quotes') || pathname.startsWith('/b2b/bulk')) {
    const session = req.cookies.get(SESSION_COOKIE);
    if (!session) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('next', pathname);
      const r = NextResponse.redirect(url);
      r.headers.set('x-request-id', reqId);
      return r;
    }
  }

  // ─── Phone Verification gate ─────────────────────────────────────────
  //
  // If the session JWT carries `status: PENDING_PHONE_VERIFICATION`, the
  // user has verified their email but NOT their phone. They may only
  // reach the verify-phone page + a small set of auth endpoints.
  //
  // Reading the JWT is signature-UNVERIFIED — Edge runtime + this is a
  // routing hint, not a security boundary. Pre-existing sessions minted
  // before this feature lack the claim → we treat absent as ACTIVE and
  // let the request through.
  const sessionToken =
    req.cookies.get(SESSION_COOKIE)?.value
    ?? req.cookies.get(ADMIN_COOKIE)?.value;
  const status = readStatusClaim(sessionToken);
  if (status === 'PENDING_PHONE_VERIFICATION') {
    const allowed = PHONE_PENDING_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
    const protectedSurface =
      PHONE_PENDING_PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
    if (!allowed && protectedSurface) {
      const url = req.nextUrl.clone();
      url.pathname = '/verify-phone';
      url.searchParams.set('next', pathname);
      const r = NextResponse.redirect(url);
      r.headers.set('x-request-id', reqId);
      return r;
    }
  }

  // Feature #9 — never let the browser bfcache an authenticated page. After
  // logout the back button must NOT restore the previous user's UI. The
  // BackButtonGuard component is the JS belt; this is the HTTP-header braces.
  // We apply it to authed surfaces only; public pages can still bfcache.
  if (
    pathname.startsWith('/account') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/b2b/dashboard') ||
    pathname.startsWith('/b2b/quotes') ||
    pathname.startsWith('/b2b/bulk') ||
    pathname.startsWith('/checkout') ||
    pathname.startsWith('/orders')
  ) {
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.headers.set('Pragma', 'no-cache');
  }

  return res;
}

export const config = {
  matcher: [
    // Run on everything except Next internals + static assets + the public health/ready endpoints
    '/((?!_next/static|_next/image|favicon.ico|api/health|api/ready).*)',
  ],
};
