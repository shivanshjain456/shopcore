/**
 * CSRF protection — double-submit cookie pattern.
 *
 *  - `sc_csrf` cookie is set with a random token (NOT HttpOnly so client JS can read it)
 *  - All unsafe-method requests (POST/PUT/PATCH/DELETE) must send the same token
 *    in the `x-csrf-token` header.
 *  - Server compares cookie vs header with constant-time equality.
 *
 * Why this is sufficient at our scale:
 *  - SameSite=Strict on sc_session already blocks most CSRF
 *  - Double-submit catches the remaining edge cases (e.g. subdomain takeover)
 *  - No third-party services needed
 */
import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';

const CSRF_COOKIE = 'sc_csrf';

export function ensureCsrfCookie(): string {
  const c = cookies();
  let token = c.get(CSRF_COOKIE)?.value;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    c.set(CSRF_COOKIE, token, {
      httpOnly: false, // client must read it
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24, // 1 day; refreshed on every page load
    });
  }
  return token;
}

export function getCsrfTokenFromCookie(): string | null {
  return cookies().get(CSRF_COOKIE)?.value ?? null;
}

/** Throws if CSRF check fails. Call from every state-changing API route. */
export function assertCsrf(): void {
  const cookieTok = cookies().get(CSRF_COOKIE)?.value;
  const headerTok = headers().get('x-csrf-token');
  if (!cookieTok || !headerTok) {
    throw new CsrfError('Missing CSRF token.');
  }
  const a = Buffer.from(cookieTok);
  const b = Buffer.from(headerTok);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new CsrfError('Invalid CSRF token.');
  }
}

export class CsrfError extends Error {
  status = 403;
}
