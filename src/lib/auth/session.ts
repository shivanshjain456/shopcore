/**
 * Session management — Bug #7 hardened with refresh-token rotation.
 *
 * Hybrid model:
 *  - ACCESS  : short-lived (15 min) JWT (jose, HS256) in HttpOnly cookie.
 *              Stateless decode on the hot path; the DB row is consulted
 *              cheaply to enforce server-side revocation.
 *  - REFRESH : opaque 32-byte secret in a SEPARATE HttpOnly cookie scoped
 *              to /api/auth only. Family-tracked + single-use; every
 *              rotation invalidates the prior secret. See `lib/auth/refresh.ts`.
 *
 * Two cookie pairs:
 *  - sc_session  + sc_refresh        → CUSTOMER / B2B
 *  - sc_admin    + sc_admin_refresh  → ADMIN  (separate so admin can't be
 *                                              elevated from a storefront cookie)
 *
 * Hot-path API unchanged: `getSession()` / `getCurrentUser()` still work
 * exactly the same for downstream callers. Internally they will silently
 * trigger a refresh (and update cookies) when the access token is expired
 * but the refresh token is still valid — keeping UX seamless without
 * leaking the rotation mechanics to the rest of the codebase.
 */
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/config';
import type { UserRole } from '@/lib/enums';
import {
  issueRefreshFamily, rotateRefresh, revokeFamily,
  refreshCookieNameFor, REFRESH_COOKIE, REFRESH_COOKIE_ADMIN, REFRESH_COOKIE_PATH,
  accessTtlFor, refreshFamilyTtlFor,
} from './refresh';
// Pure helpers from the Account State Machine. We import from the
// helper file (not from accountStateMachine.ts) to keep this module a
// LEAF of the state-machine dependency graph — accountStateMachine.ts
// imports `revokeAllSessions` from here, so importing back would cycle.
import { isLoginPermitted } from '@/lib/auth/accountStateHelpers';

const SESSION_COOKIE = 'sc_session';
const ADMIN_COOKIE   = 'sc_admin';

const secretKey = () => new TextEncoder().encode(env.SESSION_SECRET);

export interface SessionClaims {
  sub: string;       // user id
  role: UserRole;
  email: string;
  jti: string;       // session row id
  fam: string;       // refresh-token family id
  /** Account-state snapshot at the time the access token was minted.
   *
   *  Used by middleware (Edge runtime) for ROUTING decisions only — never
   *  as a security gate. Route handlers always re-check the DB via
   *  `getCurrentUser` / `isLoginPermitted`. Pre-existing sessions minted
   *  before this feature lack the claim; middleware treats absent as
   *  `ACTIVE` for backwards compatibility. */
  status?: string;
  // jose-managed: iat, exp
}

function cookieName(role: UserRole): string {
  return role === 'ADMIN' ? ADMIN_COOKIE : SESSION_COOKIE;
}

function clientIp(): string | null {
  const fwd = headers().get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return headers().get('x-real-ip') ?? null;
}
function ua(): string | null { return headers().get('user-agent') ?? null; }

/** Sign an access JWT + persist a Session row whose tokenHash = sha256(jwt). */
async function mintAccessToken(params: {
  user: { id: string; role: UserRole; email: string; status?: string };
  familyId: string;
}): Promise<{ jwt: string; sessionId: string; expiresAt: Date }> {
  const ttl = accessTtlFor(params.user.role);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const rowId = crypto.randomBytes(16).toString('hex');

  const jwt = await new SignJWT({
    sub: params.user.id,
    role: params.user.role,
    email: params.user.email,
    jti: rowId,
    fam: params.familyId,
    // Account-state snapshot — middleware-only routing hint. See note on
    // SessionClaims.status. Falls back to ACTIVE if the caller didn't
    // pass it (legacy callers / refresh-rotation path that fetches the
    // user row will always supply a real value).
    status: params.user.status ?? 'ACTIVE',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey());

  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({
    data: {
      id: rowId,
      userId: params.user.id,
      tokenHash,
      ipAddress: clientIp(),
      userAgent: ua(),
      expiresAt,
      refreshFamilyId: params.familyId,
    },
  });
  return { jwt, sessionId: rowId, expiresAt };
}

function setAccessCookie(role: UserRole, jwt: string, ttlSec: number): void {
  cookies().set(cookieName(role), jwt, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ttlSec,
  });
}
function setRefreshCookie(role: UserRole, secret: string, expiresAt: Date): void {
  cookies().set(refreshCookieNameFor(role), secret, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}
function clearAuthCookies(): void {
  const c = cookies();
  for (const name of [SESSION_COOKIE, ADMIN_COOKIE]) c.delete(name);
  for (const name of [REFRESH_COOKIE, REFRESH_COOKIE_ADMIN]) {
    // Match the path we set them on so the browser actually clears.
    c.set(name, '', {
      httpOnly: true, secure: env.NODE_ENV === 'production',
      sameSite: 'strict', path: REFRESH_COOKIE_PATH, maxAge: 0,
    });
  }
}

/**
 * Create a session: open a new refresh family, mint an access JWT, set both
 * cookies. Call this on successful login / OTP verification.
 */
export async function createSession(user: { id: string; role: UserRole; email: string; status?: string }): Promise<void> {
  // 1) Open a refresh family + first refresh token
  const fam = await issueRefreshFamily({
    userId: user.id, role: user.role, ipAddress: clientIp(), userAgent: ua(),
  });
  // 2) Mint an access JWT bound to that family. If the caller didn't
  //    supply `status`, fetch it so the JWT carries the truth.
  let status = user.status;
  if (!status) {
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } });
    status = row?.status ?? 'ACTIVE';
  }
  const access = await mintAccessToken({ user: { ...user, status }, familyId: fam.familyId });
  // 3) Set both cookies
  setAccessCookie(user.role, access.jwt, accessTtlFor(user.role));
  setRefreshCookie(user.role, fam.secret, fam.expiresAt);
}

/** What `tryRefreshAccessToken()` decides to do on the way in. */
type LazyRefreshOutcome =
  | { kind: 'refreshed'; claims: SessionClaims }
  | { kind: 'no_refresh_cookie' }
  | { kind: 'invalid' }
  | { kind: 'reuse' };

/**
 * If we have a valid refresh cookie, rotate it and mint a fresh access JWT.
 * Called transparently by `getSession()` when the access token is missing
 * or expired — keeps existing callers' UX seamless.
 */
async function tryRefreshAccessToken(role: UserRole): Promise<LazyRefreshOutcome> {
  const c = cookies();
  const refreshCookie = role === 'ADMIN' ? REFRESH_COOKIE_ADMIN : REFRESH_COOKIE;
  const secret = c.get(refreshCookie)?.value ?? null;
  if (!secret) return { kind: 'no_refresh_cookie' };

  const r = await rotateRefresh({
    presentedSecret: secret, ipAddress: clientIp(), userAgent: ua(),
  });

  if (r.kind === 'reuse') {
    clearAuthCookies();
    return { kind: 'reuse' };
  }
  if (r.kind !== 'rotated') {
    // expired / revoked / invalid → drop cookies, force fresh login
    clearAuthCookies();
    return { kind: 'invalid' };
  }

  // Mint a NEW access JWT bound to the same family; set both cookies anew.
  const user = await prisma.user.findUnique({ where: { id: r.userId } });
  if (!user) { clearAuthCookies(); return { kind: 'invalid' }; }

  const access = await mintAccessToken({
    user: { id: user.id, role: user.role as UserRole, email: user.email, status: user.status },
    familyId: r.familyId,
  });
  setAccessCookie(user.role as UserRole, access.jwt, accessTtlFor(user.role as UserRole));
  setRefreshCookie(user.role as UserRole, r.secret, r.expiresAt);

  return {
    kind: 'refreshed',
    claims: {
      sub: user.id, role: user.role as UserRole, email: user.email,
      jti: access.sessionId, fam: r.familyId, status: user.status,
    } as SessionClaims,
  };
}

/**
 * Read + verify the session for the current request.
 * Returns null if no/bad/expired/revoked.
 * Pass `requireAdmin: true` to only accept the admin cookie.
 *
 * Transparently runs a refresh-token rotation if the access token is
 * expired or missing but a valid refresh cookie is present.
 */
export async function getSession(opts?: { requireAdmin?: boolean }): Promise<SessionClaims | null> {
  const c = cookies();
  const token = opts?.requireAdmin
    ? c.get(ADMIN_COOKIE)?.value
    : (c.get(SESSION_COOKIE)?.value ?? c.get(ADMIN_COOKIE)?.value);

  if (token) {
    // Try to decode + verify the access JWT first (fast path)
    let claims: SessionClaims | null = null;
    try {
      const { payload } = await jwtVerify(token, secretKey());
      claims = payload as unknown as SessionClaims;
    } catch {
      claims = null;  // expired or tampered → fall through to refresh
    }
    if (claims) {
      if (opts?.requireAdmin && claims.role !== 'ADMIN') return null;
      // Server-side revocation check
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const row = await prisma.session.findUnique({ where: { tokenHash } });
      if (row && !row.revokedAt && row.expiresAt.getTime() >= Date.now()) {
        return claims;
      }
      // Session row says revoked / expired — fall through to refresh
    }
  }

  // No / expired access token — try refresh
  const role: UserRole = opts?.requireAdmin ? 'ADMIN' : 'CUSTOMER';
  const refreshed = await tryRefreshAccessToken(role);
  if (refreshed.kind === 'refreshed') {
    if (opts?.requireAdmin && refreshed.claims.role !== 'ADMIN') return null;
    return refreshed.claims;
  }

  // Bug #7 (re-auth on reuse) — handled by clearAuthCookies in
  // tryRefreshAccessToken; surface as "no session" so middleware redirects
  // the user to login.
  return null;
}

/** Get the current logged-in user (full row) or null.
 *
 *  Gates on the Account State Machine's `isLoginPermitted()` — currently
 *  only ACTIVE returns true, but routing the check through the helper
 *  means any future state that permits login (e.g. PENDING_PHONE_VERIFY)
 *  doesn't require touching this function. Imported from the pure
 *  helpers module to avoid an import cycle (this file is one of the
 *  modules `accountStateMachine.ts` depends on). */
export async function getCurrentUser(opts?: { requireAdmin?: boolean }) {
  const s = await getSession(opts);
  if (!s) return null;
  const user = await prisma.user.findUnique({ where: { id: s.sub } });
  if (!user || !isLoginPermitted(user.status)) return null;
  return user;
}

/**
 * Logout the CURRENT session/family.
 *
 *  - Revoke the active refresh family (kills every device using this family,
 *    which under our scheme is just the current device).
 *  - Revoke any non-revoked Session rows linked to that family.
 *  - Clear cookies.
 */
export async function destroySession(): Promise<void> {
  const c = cookies();
  // Try to extract familyId from whichever access token is present
  let familyId: string | null = null;
  for (const name of [SESSION_COOKIE, ADMIN_COOKIE]) {
    const tok = c.get(name)?.value;
    if (!tok) continue;
    try {
      const { payload } = await jwtVerify(tok, secretKey());
      const fam = (payload as unknown as SessionClaims).fam;
      if (fam) { familyId = fam; break; }
    } catch { /* token invalid — keep trying */ }

    // Even if JWT is invalid, revoke the session row so a stolen-then-decoded
    // copy can't be used. Short-circuit when the row is already revoked or
    // absent — important for Feature #9's (R2) parallel-storm test where N
    // concurrent logouts must NOT pile up SQLite write transactions.
    const tokenHash = crypto.createHash('sha256').update(tok).digest('hex');
    const row = await prisma.session.findUnique({
      where: { tokenHash }, select: { revokedAt: true },
    });
    if (row && !row.revokedAt) {
      await prisma.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  if (familyId) await revokeFamily(familyId, 'USER_LOGOUT');
  clearAuthCookies();
}

/** Re-issue the CURRENT request's access-token cookie with a fresh
 *  `status` claim — used by routes that mutate `User.status` while the
 *  user is logged in (e.g. /api/auth/phone/verify completing
 *  PENDING_PHONE_VERIFICATION → ACTIVE). Without this, the middleware
 *  would keep redirecting the user to /verify-phone for the next 15
 *  minutes (until access TTL expires) because the OLD JWT still
 *  carries the old status claim.
 *
 *  Reuses the existing refresh family — does NOT rotate the refresh
 *  cookie — so any concurrent tab with a live refresh secret keeps
 *  working. The OLD access token is left to expire naturally; an
 *  attacker with the old cookie can't reach `PENDING_PHONE_VERIFICATION`
 *  surfaces anyway because route handlers always re-check the DB.
 *
 *  No-op if there is no current session cookie (caller must be inside
 *  a request that produced one).                                       */
export async function reissueAccessTokenForCurrentRequest(): Promise<void> {
  const c = cookies();
  const customer = c.get(SESSION_COOKIE)?.value;
  const admin    = c.get(ADMIN_COOKIE)?.value;
  const token = customer ?? admin;
  if (!token) return;
  let claims: SessionClaims;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    claims = payload as unknown as SessionClaims;
  } catch { return; }
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, role: true, email: true, status: true },
  });
  if (!user) return;
  const access = await mintAccessToken({
    user: { id: user.id, role: user.role as UserRole, email: user.email, status: user.status },
    familyId: claims.fam,
  });
  setAccessCookie(user.role as UserRole, access.jwt, accessTtlFor(user.role as UserRole));
  // Best-effort: revoke the OLD session row so the prior access token
  // can't be reused.
  const oldHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    await prisma.session.updateMany({
      where: { tokenHash: oldHash, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
  } catch { /* non-fatal */ }
}

/** Revoke every active session AND every refresh family for a user.
 *  Used by password change, admin suspend, "log out everywhere" UI. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await prisma.refreshTokenFamily.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKE' },
  });
}
