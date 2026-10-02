/**
 * POST /api/auth/refresh
 *
 * Explicit refresh-token rotation. Most callers don't need to hit this —
 * `getSession()` transparently refreshes on the way in. This endpoint exists
 * for SPAs/mobile clients that want to rotate proactively before an access
 * token expires, and as the canonical surface for our test suite.
 *
 * Contract:
 *   - Reads the refresh cookie (sc_refresh / sc_admin_refresh).
 *   - On success: sets a fresh refresh cookie + a fresh access JWT,
 *     returns 200 with the new family id + access expiry.
 *   - On reuse-detected: returns 401 with code='REUSE_DETECTED'; the entire
 *     token family has been invalidated by `rotateRefresh()`. The client
 *     must redirect the user to /login.
 *   - On expired / unknown / revoked / invalid: returns 401 with the
 *     specific code; client must redirect to login.
 *
 * NOTE: this endpoint does NOT require CSRF — it's a pure cookie→cookie
 *       rotation, never carries a body, and is only useful when the
 *       attacker already controls the refresh cookie (which the rotation
 *       itself detects via the reuse path). We add a strict same-origin
 *       check below as defence-in-depth.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { cookies, headers } from 'next/headers';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/config';
import {
  rotateRefresh,
  REFRESH_COOKIE, REFRESH_COOKIE_ADMIN, REFRESH_COOKIE_PATH,
  accessTtlFor,
} from '@/lib/auth/refresh';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import type { UserRole } from '@/lib/enums';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'sc_session';
const ADMIN_COOKIE   = 'sc_admin';
const secretKey = () => new TextEncoder().encode(env.SESSION_SECRET);

function strictOrigin(req: NextRequest): boolean {
  // Same-origin guard: cookies are SameSite=Strict but belt+braces.
  const origin = req.headers.get('origin');
  const host   = req.headers.get('host');
  if (!origin || !host) return true; // some clients omit Origin — accept
  try { return new URL(origin).host === host; } catch { return false; }
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  if (!strictOrigin(req)) return jsonError('Cross-origin refresh blocked.', 403);

  // Cheap brute-force guard — refresh secrets are 32-byte random but still
  // worth limiting to make scanning expensive.
  const ip = clientIp();
  await applyRateLimit('auth.refresh', req);

  const c = cookies();
  // Prefer admin cookie if both happen to be present (admin sessions need it)
  const adminSecret    = c.get(REFRESH_COOKIE_ADMIN)?.value ?? null;
  const customerSecret = c.get(REFRESH_COOKIE)?.value ?? null;
  const presented = adminSecret ?? customerSecret;
  if (!presented) {
    return jsonError('No refresh token.', 401, { code: 'NO_REFRESH_COOKIE' });
  }
  const isAdminAttempt = !!adminSecret;

  const r = await rotateRefresh({
    presentedSecret: presented,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
  });

  if (r.kind === 'reuse') {
    // The helper already revoked the family + linked sessions. Clear cookies.
    const res = jsonError('Refresh token reuse detected — please sign in again.', 401, { code: 'REUSE_DETECTED' });
    clearAuthCookies(res);
    log.warn('refresh.endpoint.reuse', { ip });
    return res;
  }
  if (r.kind === 'expired') {
    const res = jsonError('Refresh token expired.', 401, { code: 'EXPIRED' });
    clearAuthCookies(res);
    return res;
  }
  if (r.kind === 'revoked') {
    const res = jsonError('Session was revoked. Please sign in again.', 401, { code: 'REVOKED' });
    clearAuthCookies(res);
    return res;
  }
  if (r.kind === 'invalid') {
    const res = jsonError('Invalid refresh token.', 401, { code: 'INVALID' });
    clearAuthCookies(res);
    return res;
  }

  // r.kind === 'rotated' — mint a new access JWT bound to the same family
  const user = await prisma.user.findUnique({ where: { id: r.userId } });
  if (!user || user.status !== 'ACTIVE') {
    const res = jsonError('Account is not active.', 401, { code: 'INACTIVE' });
    clearAuthCookies(res);
    return res;
  }

  const ttl = accessTtlFor(user.role as UserRole);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');

  const jwt = await new SignJWT({
    sub: user.id, role: user.role, email: user.email,
    jti: sessionId, fam: r.familyId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey());

  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({
    data: {
      id: sessionId, userId: user.id, tokenHash,
      ipAddress: ip, userAgent: req.headers.get('user-agent'),
      expiresAt, refreshFamilyId: r.familyId,
    },
  });

  const accessCookie  = isAdminAttempt ? ADMIN_COOKIE : SESSION_COOKIE;
  const refreshCookie = isAdminAttempt ? REFRESH_COOKIE_ADMIN : REFRESH_COOKIE;

  const res = jsonOk({
    familyId: r.familyId,
    accessExpiresAt:  expiresAt.toISOString(),
    refreshExpiresAt: r.expiresAt.toISOString(),
  });
  res.headers.append('Set-Cookie', cookieHeader(accessCookie, jwt, {
    path: '/', maxAge: ttl,
  }));
  res.headers.append('Set-Cookie', cookieHeader(refreshCookie, r.secret, {
    path: REFRESH_COOKIE_PATH, expires: r.expiresAt,
  }));
  return res;
});

function clearAuthCookies(res: NextResponse): void {
  for (const name of [SESSION_COOKIE, ADMIN_COOKIE]) {
    res.headers.append('Set-Cookie', cookieHeader(name, '', { path: '/', maxAge: 0 }));
  }
  for (const name of [REFRESH_COOKIE, REFRESH_COOKIE_ADMIN]) {
    res.headers.append('Set-Cookie', cookieHeader(name, '', { path: REFRESH_COOKIE_PATH, maxAge: 0 }));
  }
}

function cookieHeader(name: string, value: string, opts: { path: string; maxAge?: number; expires?: Date }): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, 'HttpOnly', 'SameSite=Strict'];
  if (env.NODE_ENV === 'production') parts.push('Secure');
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  void headers; // keep import to mirror cookies semantics for SSR contexts
  return parts.join('; ');
}
