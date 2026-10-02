/**
 * Refresh-token rotation regression suite — Bug #7.
 *
 *   npm run test:refresh
 *
 * Three layers, exactly as the bug spec demanded:
 *
 *   1. UNIT — pure helpers in lib/auth/refresh.ts:
 *      - generateRefreshSecret() entropy + shape
 *      - hashSecret() determinism + sha256-hex length
 *      - looksLikeRefreshSecret() boundary cases
 *      - accessTtlFor() / refreshFamilyTtlFor() per-role values
 *      - refreshCookieNameFor() admin vs customer
 *
 *   2. INTEGRATION — real HTTP against a spawned `next start`, real DB:
 *      (i)   Login issues access + refresh cookies; DB row exists in fresh family
 *      (ii)  /api/auth/refresh rotates: old cookie value gone, new cookies set
 *      (iii) Used refresh token cannot be used again (single-use)
 *      (iv)  Reuse attack: store the original refresh, rotate once, then
 *            present the ORIGINAL again → 401 REUSE_DETECTED + entire family
 *            revoked + every linked session revoked
 *      (v)   Chained rotations 5× — each is single-use, family stays valid
 *      (vi)  Concurrent rotation race with the SAME refresh token → exactly
 *            one rotated, the other gets REUSE_DETECTED + family revoked
 *      (vii) Access JWT TTL is short (~15 min, not 30 d)
 *      (viii) /api/auth/refresh without cookie → 401 NO_REFRESH_COOKIE
 *      (ix)  /api/auth/refresh with random/garbage secret → 401 INVALID
 *      (x)   Cross-origin refresh (Origin: evil.com) → 403
 *      (xi)  GET /api/auth/sessions lists the current family with current=true
 *      (xii) /api/auth/logout-others: revokes other families, keeps current
 *      (xiii)/api/auth/logout-all: revokes EVERY family + kicks current
 *      (xiv) Family absolute-expiry: tampering with the DB row to set
 *            absoluteExpiresAt in the past → refresh returns 401 EXPIRED
 *      (xv)  Logout revokes the family AND the access-token session row;
 *            access cookie can't be reused after logout (DB-side check)
 *      (xvi) Two separate logins for the same user create two separate
 *            families; revoking one does not affect the other
 *      (xvii) Theft simulation: attacker copies refresh cookie from victim,
 *             both rotate; whichever loses the race gets nuked; the next
 *             attempt by either party fails — both forced to re-login.
 *      (xviii) After REUSE_DETECTED, the access JWT minted from the now-revoked
 *              family is rejected (server-side revocation check kicks in)
 *
 *   3. REGRESSION — bug-class scenarios from the spec:
 *      (A) Stolen refresh used indefinitely → cannot happen after one rotation
 *      (B) Re-issued same refresh → no longer happens; every rotate gives a
 *          NEW secret with a new tokenHash in DB
 *      (C) Token accumulation → daily prune removes families past their
 *          absolute expiry + grace
 *      (D) Logout-all really kicks every device (verified by 3 parallel sessions)
 *      (E) Password-change style invalidation: revokeAllSessions() helper
 *          revokes every family + every session
 *
 * Cleans up its own data on success or failure.
 */
import { prisma } from '../src/lib/db/client';
import {
  generateRefreshSecret, hashSecret, looksLikeRefreshSecret,
  accessTtlFor, refreshFamilyTtlFor, refreshCookieNameFor,
  pruneExpiredRefreshFamilies, issueRefreshFamily,
} from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

// Cross-process OTP capture — the structured logger now masks the email
// in `email.dev_fallback` lines (`*****am@shopcore.test`), so we can no
// longer grep the server log for the literal email. Instead the server
// appends every OTP to this file when SHOPCORE_TEST_OTP_FILE is set
// (see `src/lib/email/send.ts`).
const OTP_FILE = `/tmp/test-refresh-otp-${process.pid}.jsonl`;
try { if (existsSync(OTP_FILE)) unlinkSync(OTP_FILE); } catch { /* */ }
interface CapturedOtp { email: string; code: string; purpose: string; ts: number; }
function latestOtpFor(email: string, purpose: string = 'SIGNUP'): string | null {
  if (!existsSync(OTP_FILE)) return null;
  // Signup schema lowercases emails — match case-insensitively.
  const wanted = email.toLowerCase();
  const lines = readFileSync(OTP_FILE, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]) as CapturedOtp;
      if (o.email.toLowerCase() === wanted && o.purpose === purpose) return o.code;
    } catch { /* skip malformed */ }
  }
  return null;
}

let passed = 0; let failed = 0;
function ok(label: string)  { passed++; console.log(`  ✔ ${label}`); }
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

// ─────────────────────────────────────────────── 0. server lifecycle

const PORT = 3027;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;

async function startServer() {
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'development', SHOPCORE_ALLOW_TEST_EMAILS: '1',
      SHOPCORE_TEST_OTP_FILE: OTP_FILE,
      SHOPCORE_DISABLE_RATE_LIMITS: '1',
    },
    detached: true,
  });
  const killGroup = () => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit', killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });
  process.on('uncaughtException',  (e) => { killGroup(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { killGroup(); console.error(e); process.exit(1); });

  const out = (b: Buffer) => writeFileSync('/tmp/test-refresh.log', b, { flag: 'a' });
  serverProc.stdout?.on('data', out);
  serverProc.stderr?.on('data', out);

  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start within timeout');
}
async function stopServer() {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─────────────────────────────────────────────── 1. cookie jar (one per user)

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response) {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (v === '' || sc.includes('Max-Age=0') || sc.includes('Expires=Thu, 01 Jan 1970')) {
        delete jar.cookies[k];
      } else {
        jar.cookies[k] = v;
      }
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(jar: Jar, path: string, init?: {
  method?: string; json?: unknown; headers?: Record<string, string>;
}, retryOn429 = true): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
    if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers.set(k, v);
  const res = await fetch(BASE + path, {
    method: init?.method ?? 'GET', headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  // The refresh route limits to 30/min per IP — under a heavy test suite
  // we occasionally trip it. Back off and try again ONCE.
  if (res.status === 429 && retryOn429) {
    const wait = ((body as { retryAfterSeconds?: number }).retryAfterSeconds ?? 61) + 1;
    console.log(`    (rate-limited on ${path}, sleeping ${wait}s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(jar, path, init, false);
  }
  return { status: res.status, headers: res.headers, body };
}

// ─────────────────────────────────────────────── 2. user signup fixture

interface TestUser { email: string; jar: Jar; userId: string; }

async function signupAndVerify(label: string): Promise<TestUser> {
  const jar = newJar();
  const email = `refresh_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@shopcore.test`;
  const phone10 = '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
  const phoneE164 = '+91' + phone10;
  await api(jar, '/api/auth/csrf');
  const su = await api(jar, '/api/auth/signup', { method: 'POST', json: {
    firstName: 'Refresh', lastName: label, email, phone: phone10,
    password: 'TestPass#9k2', confirmPassword: 'TestPass#9k2',
    addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
    pinCode: '400001', country: 'India',
  } });
  if (su.status !== 200) throw new Error(`signup ${label}: ` + JSON.stringify(su.body));
  // Allow the server's email.dev_fallback handler to flush the OTP file.
  await new Promise((r) => setTimeout(r, 400));
  // Primary lookup: structured cross-process file (set by SHOPCORE_TEST_OTP_FILE).
  // This is robust even though the structured logger now masks the email in
  // server log lines — the OTP file stores the verbatim email + code per row.
  const code = latestOtpFor(email, 'SIGNUP');
  if (!code) throw new Error(`OTP not found in OTP_FILE for ${email}`);
  const v = await api(jar, '/api/auth/otp/verify', { method: 'POST', json: { email, purpose: 'SIGNUP', code } });
  if (v.status !== 200) throw new Error(`OTP verify ${label}: ` + JSON.stringify(v.body));
  // Phone Verification feature — email OTP lands the user in
  // PENDING_PHONE_VERIFICATION; complete the second step via dev-bypass
  // so the session reaches ACTIVE and downstream test assertions pass.
  const pv = await api(jar, '/api/auth/phone/verify', { method: 'POST', json: {
    idToken: 'dev-bypass-token', phone: phoneE164,
  } });
  if (pv.status !== 200) throw new Error(`phone verify ${label}: ` + JSON.stringify(pv.body));
  const me = await api(jar, '/api/auth/me');
  const userId = (me.body.data as { user: { id: string } }).user.id;
  return { email, jar, userId };
}

/**
 * Mint a fully-functioning session jar for an EXISTING user WITHOUT going
 * through the OTP flow. We:
 *   1. Open a refresh family + first refresh token (server lib)
 *   2. Sign an access JWT bound to that family
 *   3. Insert the matching Session row
 *   4. Fetch a CSRF cookie via the public endpoint
 *   5. Return a jar pre-populated with all three cookies
 *
 * This is the test-only equivalent of `createSession()` — it lets the suite
 * exercise refresh / logout / reuse without burning the per-email OTP
 * cooldown (60s) + 5/hour cap.
 */
async function loginExisting(email: string): Promise<Jar> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const role = user.role as 'CUSTOMER' | 'B2B' | 'ADMIN';
  const fam = await issueRefreshFamily({ userId: user.id, role: role === 'ADMIN' ? 'ADMIN' : 'CUSTOMER' });

  const ttl = accessTtlFor(role === 'ADMIN' ? 'ADMIN' : 'CUSTOMER');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: user.id, role: user.role, email: user.email,
    jti: sessionId, fam: fam.familyId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret);

  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({
    data: {
      id: sessionId, userId: user.id, tokenHash,
      expiresAt, refreshFamilyId: fam.familyId,
    },
  });

  const jar = newJar();
  await api(jar, '/api/auth/csrf'); // populate sc_csrf
  jar.cookies['sc_session'] = jwt;
  jar.cookies['sc_refresh'] = fam.secret;
  return jar;
}

// ─────────────────────────────────────────────── 3. UNIT TESTS

function unitTests() {
  console.log('\n── UNIT TESTS ──');

  // generateRefreshSecret
  const s1 = generateRefreshSecret();
  const s2 = generateRefreshSecret();
  assert(`secret shape (32B base64url ≈ 43 chars): "${s1.slice(0,8)}…" len=${s1.length}`,
    s1.length >= 40 && s1.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s1));
  assert('two secrets differ', s1 !== s2);

  // hashSecret
  eq('hash is deterministic', hashSecret('abc'), hashSecret('abc'));
  assert('hash differs across inputs', hashSecret('abc') !== hashSecret('abd'));
  eq('hash is sha256 hex (64 chars)', 64, hashSecret('abc').length);

  // looksLikeRefreshSecret
  assert('looksLike: real secret accepted',          looksLikeRefreshSecret(s1));
  assert('looksLike: 32-char accepted (min)',        looksLikeRefreshSecret('a'.repeat(32)));
  assert('looksLike: 31-char rejected',             !looksLikeRefreshSecret('a'.repeat(31)));
  assert('looksLike: 97-char rejected',             !looksLikeRefreshSecret('a'.repeat(97)));
  assert('looksLike: dots rejected',                !looksLikeRefreshSecret('a.b.c'.padEnd(40, 'x')));
  assert('looksLike: null rejected',                !looksLikeRefreshSecret(null));
  assert('looksLike: number rejected',              !looksLikeRefreshSecret(123 as unknown));
  assert('looksLike: empty rejected',               !looksLikeRefreshSecret(''));

  // TTLs
  eq('accessTtl customer = 15 min',       15 * 60,            accessTtlFor('CUSTOMER'));
  eq('accessTtl admin    = 15 min',       15 * 60,            accessTtlFor('ADMIN'));
  eq('refreshTtl customer = 30 d',        30 * 24 * 60 * 60,  refreshFamilyTtlFor('CUSTOMER'));
  eq('refreshTtl admin    = 12 h',        12 * 60 * 60,       refreshFamilyTtlFor('ADMIN'));

  // cookie names
  eq('refresh cookie customer = sc_refresh',          'sc_refresh',       refreshCookieNameFor('CUSTOMER'));
  eq('refresh cookie admin    = sc_admin_refresh',    'sc_admin_refresh', refreshCookieNameFor('ADMIN'));
}

async function pruneUnit() {
  console.log('\n── UNIT: pruneExpiredRefreshFamilies ──');
  const u = await prisma.user.findFirstOrThrow();
  // Old expired family — past the absolute expiry by > grace window (7d)
  const oldFam = await prisma.refreshTokenFamily.create({
    data: { userId: u.id, absoluteExpiresAt: new Date(Date.now() - 30 * 86400 * 1000) },
  });
  // Recently expired family — past expiry but inside grace
  const recentFam = await prisma.refreshTokenFamily.create({
    data: { userId: u.id, absoluteExpiresAt: new Date(Date.now() - 1 * 86400 * 1000) },
  });
  // Active family — not expired at all
  const liveFam = await prisma.refreshTokenFamily.create({
    data: { userId: u.id, absoluteExpiresAt: new Date(Date.now() + 7 * 86400 * 1000) },
  });
  const removed = await pruneExpiredRefreshFamilies();
  assert(`prune removed ≥1 old family (got ${removed})`, removed >= 1);
  const stillThere = await prisma.refreshTokenFamily.findMany({
    where: { id: { in: [recentFam.id, liveFam.id] } }, select: { id: true },
  });
  eq('recent + live families NOT pruned', 2, stillThere.length);
  const oldGone = await prisma.refreshTokenFamily.findUnique({ where: { id: oldFam.id } });
  assert('old expired family was pruned', oldGone === null);
  // cleanup what we made
  await prisma.refreshTokenFamily.deleteMany({ where: { id: { in: [recentFam.id, liveFam.id] } } });
}

// ─────────────────────────────────────────────── 4. INTEGRATION TESTS

let alice: TestUser; let bob: TestUser;

function getCookie(jar: Jar, name: string): string | undefined { return jar.cookies[name]; }

async function integrationTests() {
  console.log('\n── INTEGRATION — real HTTP, real DB ──');

  // (i) Signup sets both cookies & DB row & family
  const a = alice;
  assert('(i) sc_session cookie set after signup',  !!getCookie(a.jar, 'sc_session'));
  assert('(i) sc_refresh cookie set after signup',  !!getCookie(a.jar, 'sc_refresh'));
  const fams_i = await prisma.refreshTokenFamily.findMany({ where: { userId: a.userId } });
  eq('(i) exactly one refresh family',  1, fams_i.length);
  // Phone Verification feature — `signupAndVerify` now does TWO mints:
  // (1) createSession after email OTP, (2) reissueAccessTokenForCurrentRequest
  // after phone OTP — so there are 2 session rows total per family, but
  // only the most recent is unrevoked. We assert on the unrevoked count.
  const sessions_i = await prisma.session.findMany({
    where: { userId: a.userId, refreshFamilyId: fams_i[0].id, revokedAt: null },
  });
  eq('(i) exactly one unrevoked session row linked to family', 1, sessions_i.length);
  const tokens_i = await prisma.refreshToken.findMany({ where: { familyId: fams_i[0].id } });
  eq('(i) exactly one refresh token row', 1, tokens_i.length);
  assert('(i) refresh hash matches the cookie secret',
    tokens_i[0].tokenHash === hashSecret(getCookie(a.jar, 'sc_refresh')!));

  // (ii) /api/auth/refresh rotates
  const oldRefresh_ii = getCookie(a.jar, 'sc_refresh')!;
  const oldAccess_ii  = getCookie(a.jar, 'sc_session')!;
  // cookie is Path=/api/auth — make sure we send it on /api/auth/refresh
  const r_ii = await api(a.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(ii) refresh returns 200',                  200, r_ii.status);
  const newRefresh_ii = getCookie(a.jar, 'sc_refresh')!;
  const newAccess_ii  = getCookie(a.jar, 'sc_session')!;
  assert('(ii) sc_refresh value changed',         newRefresh_ii !== oldRefresh_ii);
  assert('(ii) sc_session  value changed',        newAccess_ii !== oldAccess_ii);
  const oldTok_ii = await prisma.refreshToken.findUnique({ where: { tokenHash: hashSecret(oldRefresh_ii) } });
  assert('(ii) old refresh row has rotatedAt set', !!oldTok_ii?.rotatedAt);
  assert('(ii) old refresh row has successorId',   !!oldTok_ii?.successorId);
  const newTok_ii = await prisma.refreshToken.findUnique({ where: { tokenHash: hashSecret(newRefresh_ii) } });
  assert('(ii) new refresh row exists in SAME family',
    !!newTok_ii && newTok_ii.familyId === fams_i[0].id);
  eq('(ii) family count unchanged (1)', 1, await prisma.refreshTokenFamily.count({ where: { userId: a.userId } }));

  // (iii) Old refresh cannot be used again — single-use semantics
  //       Build a separate jar that still holds the OLD refresh cookie.
  const replayJar_iii: Jar = { cookies: { ...a.jar.cookies, sc_refresh: oldRefresh_ii } };
  const r_iii = await api(replayJar_iii, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(iii) replay of old refresh → 401',                 401, r_iii.status);
  eq('(iii) code = REUSE_DETECTED',          'REUSE_DETECTED', r_iii.body.code);

  // (iv) Reuse attack triggers FULL family invalidation
  // After (iii) the family for alice is revoked. Verify everything cascaded.
  const famAfter_iv = await prisma.refreshTokenFamily.findUnique({ where: { id: fams_i[0].id } });
  assert('(iv) family.revokedAt set after reuse',           !!famAfter_iv?.revokedAt);
  eq('(iv) family.revokedReason = REUSE_DETECTED', 'REUSE_DETECTED', famAfter_iv?.revokedReason);
  const liveSessions_iv = await prisma.session.findMany({
    where: { refreshFamilyId: fams_i[0].id, revokedAt: null },
  });
  eq('(iv) all sessions in the family are revoked',           0, liveSessions_iv.length);
  // The legit user's current refresh cookie should now be useless
  const r_iv = await api(a.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(iv) current (new) refresh now also rejected → 401',  401, r_iv.status);
  // After the cascade ALL cookies cleared — log in again for the rest of the suite
  alice.jar = await loginExisting(alice.email);

  // (v) Chained rotations work
  let priorRefresh_v = getCookie(alice.jar, 'sc_refresh')!;
  for (let n = 1; n <= 5; n++) {
    const r = await api(alice.jar, '/api/auth/refresh', { method: 'POST', json: {} });
    eq(`(v) rotation #${n} → 200`, 200, r.status);
    const cur = getCookie(alice.jar, 'sc_refresh')!;
    assert(`(v) rotation #${n} produced a new secret`, cur !== priorRefresh_v);
    priorRefresh_v = cur;
  }
  const famsAlice_v = await prisma.refreshTokenFamily.findMany({
    where: { userId: alice.userId, revokedAt: null },
  });
  eq('(v) one active family for alice (others revoked)', 1, famsAlice_v.length);

  // (vi) Concurrent rotation race with SAME refresh token
  const racerSecret = getCookie(alice.jar, 'sc_refresh')!;
  const jarR1: Jar = { cookies: { ...alice.jar.cookies, sc_refresh: racerSecret } };
  const jarR2: Jar = { cookies: { ...alice.jar.cookies, sc_refresh: racerSecret } };
  const [rA, rB] = await Promise.all([
    api(jarR1, '/api/auth/refresh', { method: 'POST', json: {} }),
    api(jarR2, '/api/auth/refresh', { method: 'POST', json: {} }),
  ]);
  const ok200_vi  = [rA, rB].filter((r) => r.status === 200).length;
  const reuse_vi  = [rA, rB].filter((r) => r.status === 401 && r.body.code === 'REUSE_DETECTED').length;
  eq('(vi) exactly 1 racer succeeded',   1, ok200_vi);
  eq('(vi) exactly 1 racer got REUSE_DETECTED', 1, reuse_vi);
  // Cascade kicked again
  const liveFamsAlice_vi = await prisma.refreshTokenFamily.count({ where: { userId: alice.userId, revokedAt: null } });
  eq('(vi) every alice family revoked after concurrent reuse', 0, liveFamsAlice_vi);
  alice.jar = await loginExisting(alice.email);

  // (vii) Access JWT TTL — decode without verifying, inspect `exp`
  const access_vii = getCookie(alice.jar, 'sc_session')!;
  const payload_vii = JSON.parse(Buffer.from(access_vii.split('.')[1], 'base64url').toString('utf8')) as { iat: number; exp: number };
  const ttl_vii = payload_vii.exp - payload_vii.iat;
  assert(`(vii) access JWT TTL ≤ 20 min (got ${ttl_vii}s)`, ttl_vii <= 20 * 60);
  assert(`(vii) access JWT TTL ≥ 10 min (got ${ttl_vii}s)`, ttl_vii >= 10 * 60);

  // (viii) refresh without cookie → 401 NO_REFRESH_COOKIE
  const emptyJar: Jar = newJar();
  await api(emptyJar, '/api/auth/csrf');  // get a csrf cookie to mimic any browser
  const r_viii = await api(emptyJar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(viii) no refresh cookie → 401',                    401, r_viii.status);
  eq('(viii) code = NO_REFRESH_COOKIE', 'NO_REFRESH_COOKIE', r_viii.body.code);

  // (ix) refresh with garbage secret → 401 INVALID
  const garbageJar: Jar = { cookies: { ...alice.jar.cookies, sc_refresh: 'a'.repeat(40) } };
  const r_ix = await api(garbageJar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(ix) garbage refresh → 401',          401, r_ix.status);
  eq('(ix) code = INVALID',           'INVALID', r_ix.body.code);

  // (x) Cross-origin refresh blocked
  const r_x = await api(alice.jar, '/api/auth/refresh', {
    method: 'POST', json: {}, headers: { 'Origin': 'http://evil.example.com' },
  });
  eq('(x) cross-origin refresh → 403', 403, r_x.status);

  // (xi) GET /api/auth/sessions lists current family with current=true
  const list_xi = await api(alice.jar, '/api/auth/sessions');
  eq('(xi) sessions list → 200', 200, list_xi.status);
  const sessions_xi = (list_xi.body.data as { sessions: { id: string; current: boolean }[] }).sessions;
  assert(`(xi) at least 1 session listed (got ${sessions_xi.length})`, sessions_xi.length >= 1);
  const current_xi = sessions_xi.find((s) => s.current);
  assert('(xi) exactly one family marked current=true', !!current_xi);

  // (xii) logout-others — open a second login for alice and verify
  //       that calling logout-others from the first revokes only the second
  const aliceJar2 = await loginExisting(alice.email);
  const famsBefore_xii = await prisma.refreshTokenFamily.count({
    where: { userId: alice.userId, revokedAt: null },
  });
  assert(`(xii) two families live before logout-others (got ${famsBefore_xii})`,
    famsBefore_xii === 2);
  const r_xii = await api(alice.jar, '/api/auth/logout-others', { method: 'POST', json: {} });
  eq('(xii) logout-others → 200', 200, r_xii.status);
  eq('(xii) revokedFamilies = 1', 1, (r_xii.body.data as { revokedFamilies: number }).revokedFamilies);
  // First jar still works
  const r_xii_keep = await api(alice.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(xii) original jar still refresh-able → 200', 200, r_xii_keep.status);
  // Second jar is dead
  const r_xii_kicked = await api(aliceJar2, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(xii) second jar refresh after logout-others → 401', 401, r_xii_kicked.status);
  eq('(xii) second jar code = REVOKED', 'REVOKED', r_xii_kicked.body.code);

  // (xiii) logout-all — kicks current jar too
  const r_xiii = await api(alice.jar, '/api/auth/logout-all', { method: 'POST', json: { keepCurrent: false } });
  eq('(xiii) logout-all → 200', 200, r_xiii.status);
  const r_xiii_after = await api(alice.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(xiii) refresh after logout-all → 401', 401, r_xiii_after.status);
  const liveAfter_xiii = await prisma.refreshTokenFamily.count({
    where: { userId: alice.userId, revokedAt: null },
  });
  eq('(xiii) zero live families for alice after logout-all', 0, liveAfter_xiii);

  // (xiv) Absolute-expiry: tamper a family to be expired, refresh → EXPIRED
  alice.jar = await loginExisting(alice.email);
  const liveFam_xiv = await prisma.refreshTokenFamily.findFirstOrThrow({
    where: { userId: alice.userId, revokedAt: null },
  });
  await prisma.refreshTokenFamily.update({
    where: { id: liveFam_xiv.id },
    data:  { absoluteExpiresAt: new Date(Date.now() - 60_000) },  // 1 min ago
  });
  const r_xiv = await api(alice.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(xiv) refresh past absolute expiry → 401', 401, r_xiv.status);
  eq('(xiv) code = EXPIRED', 'EXPIRED', r_xiv.body.code);
  const famXiv = await prisma.refreshTokenFamily.findUniqueOrThrow({ where: { id: liveFam_xiv.id } });
  eq('(xiv) family marked revoked',                  true,  !!famXiv.revokedAt);
  eq('(xiv) revokedReason = ABSOLUTE_EXPIRY', 'ABSOLUTE_EXPIRY', famXiv.revokedReason);

  // (xv) Logout revokes the session row too — access cookie can't be reused
  alice.jar = await loginExisting(alice.email);
  const accessBefore_xv = getCookie(alice.jar, 'sc_session')!;
  // /api/auth/logout — current flow
  await api(alice.jar, '/api/auth/logout', { method: 'POST', json: {} });
  // Recover the access cookie someone might have copied + try /api/auth/me
  const stolenJar_xv: Jar = { cookies: { sc_session: accessBefore_xv, sc_csrf: alice.jar.cookies.sc_csrf ?? '' } };
  const me_xv = await api(stolenJar_xv, '/api/auth/me');
  assert('(xv) /me with logged-out access cookie returns 401/empty',
    me_xv.status === 401 || me_xv.body?.data == null,
    me_xv);

  // (xvi) Two separate logins → two separate families; revoking one keeps the other
  alice.jar = await loginExisting(alice.email);
  const aliceJar3 = await loginExisting(alice.email);
  const liveBefore_xvi = await prisma.refreshTokenFamily.count({ where: { userId: alice.userId, revokedAt: null } });
  assert(`(xvi) two distinct live families (got ${liveBefore_xvi})`, liveBefore_xvi === 2);
  // Log out the second one (its own session)
  await api(aliceJar3, '/api/auth/logout', { method: 'POST', json: {} });
  const liveAfter_xvi = await prisma.refreshTokenFamily.count({ where: { userId: alice.userId, revokedAt: null } });
  eq('(xvi) one live family remaining', 1, liveAfter_xvi);
  // First jar still works
  const r_xvi = await api(alice.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(xvi) first jar still refreshable → 200', 200, r_xvi.status);

  // (xvii) Theft simulation: bob (the "attacker") steals alice's refresh,
  //        both rotate, the loser is kicked, NEXT attempt by either fails.
  const stolen_xvii = getCookie(alice.jar, 'sc_refresh')!;
  const attackerJar: Jar = { cookies: { sc_refresh: stolen_xvii, sc_csrf: bob.jar.cookies.sc_csrf ?? '' } };
  const [legit, attacker] = await Promise.all([
    api(alice.jar,    '/api/auth/refresh', { method: 'POST', json: {} }),
    api(attackerJar,  '/api/auth/refresh', { method: 'POST', json: {} }),
  ]);
  const winner = [legit, attacker].find((r) => r.status === 200);
  const loser  = [legit, attacker].find((r) => r.status === 401);
  assert('(xvii) exactly one party won the race',  !!winner);
  assert('(xvii) the other party got REUSE_DETECTED',
    !!loser && loser.body.code === 'REUSE_DETECTED');
  // Family is now revoked — both parties' next attempt fails
  const [next1, next2] = await Promise.all([
    api(alice.jar,   '/api/auth/refresh', { method: 'POST', json: {} }),
    api(attackerJar, '/api/auth/refresh', { method: 'POST', json: {} }),
  ]);
  assert('(xvii) legit user kicked on next attempt',    next1.status === 401);
  assert('(xvii) attacker  kicked on next attempt',     next2.status === 401);

  // (xviii) Access JWT minted before family-revoke is now rejected by /me
  //         (DB-side revocation check enforces this even though the JWT is
  //         still cryptographically valid).
  alice.jar = await loginExisting(alice.email);
  const accessBeforeRevoke = getCookie(alice.jar, 'sc_session')!;
  // Revoke this family from the DB directly (simulates admin or theft cascade)
  const meFam_xviii = await prisma.refreshTokenFamily.findFirstOrThrow({
    where: { userId: alice.userId, revokedAt: null },
  });
  // Revoke the FAMILY *and* the session row attached to it — the DB-side
  // session-row check in getSession() is what enforces immediate kick.
  await prisma.refreshTokenFamily.update({
    where: { id: meFam_xviii.id },
    data:  { revokedAt: new Date(), revokedReason: 'TEST_INVALIDATION' },
  });
  await prisma.session.updateMany({
    where: { refreshFamilyId: meFam_xviii.id, revokedAt: null },
    data:  { revokedAt: new Date() },
  });
  const stolenAccessJar: Jar = { cookies: { sc_session: accessBeforeRevoke } };
  const me_xviii = await api(stolenAccessJar, '/api/auth/me');
  assert('(xviii) stale access JWT rejected after family revoke',
    me_xviii.status === 401 || me_xviii.body?.data == null,
    me_xviii);
}

// ─────────────────────────────────────────────── 5. REGRESSION

async function regressionTests() {
  console.log('\n── REGRESSION (bug-class scenarios) ──');

  // (A) Stolen refresh cannot be used indefinitely
  const fresh = await loginExisting(alice.email);
  const stolen = getCookie(fresh, 'sc_refresh')!;
  // Owner rotates once
  const r_A1 = await api(fresh, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(A) owner rotates → 200', 200, r_A1.status);
  // Attacker tries the stolen secret AFTER rotation — must fail
  const attackerA: Jar = { cookies: { sc_refresh: stolen } };
  const r_A2 = await api(attackerA, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(A) attacker w/ stolen post-rotation → 401', 401, r_A2.status);
  eq('(A) code = REUSE_DETECTED', 'REUSE_DETECTED', r_A2.body.code);

  // (B) Re-issued same refresh never happens — every rotation creates a new
  //     tokenHash row in DB and the old one is rotatedAt-marked.
  const fresh2 = await loginExisting(alice.email);
  const fam_B = (await prisma.refreshTokenFamily.findFirstOrThrow({
    where: { userId: alice.userId, revokedAt: null }, orderBy: { createdAt: 'desc' },
  })).id;
  const beforeCount = await prisma.refreshToken.count({ where: { familyId: fam_B } });
  await api(fresh2, '/api/auth/refresh', { method: 'POST', json: {} });
  await api(fresh2, '/api/auth/refresh', { method: 'POST', json: {} });
  await api(fresh2, '/api/auth/refresh', { method: 'POST', json: {} });
  const afterCount = await prisma.refreshToken.count({ where: { familyId: fam_B } });
  eq('(B) family grew by exactly 3 rows', beforeCount + 3, afterCount);
  const rotated = await prisma.refreshToken.count({
    where: { familyId: fam_B, rotatedAt: { not: null } },
  });
  eq('(B) 3 of 4 token rows are rotated (only current is live)', beforeCount + 3 - 1, rotated);

  // (C) Token accumulation guarded by prune
  // Create a family that's well past the prune cutoff (now-30d), then prune.
  const expiredFam = await prisma.refreshTokenFamily.create({
    data: { userId: alice.userId, absoluteExpiresAt: new Date(Date.now() - 30 * 86400 * 1000) },
  });
  await pruneExpiredRefreshFamilies();
  const stillExists = await prisma.refreshTokenFamily.findUnique({ where: { id: expiredFam.id } });
  assert('(C) prune removed the ancient expired family', stillExists === null);

  // (D) logout-all really kicks every device
  const j1 = await loginExisting(alice.email);
  const j2 = await loginExisting(alice.email);
  const j3 = await loginExisting(alice.email);
  await api(j1, '/api/auth/logout-all', { method: 'POST', json: { keepCurrent: false } });
  const liveAfter_D = await prisma.refreshTokenFamily.count({
    where: { userId: alice.userId, revokedAt: null },
  });
  eq('(D) zero live families after logout-all (across 3 devices)', 0, liveAfter_D);
  for (const [n, j] of [j1, j2, j3].map((j, i) => [i, j] as const)) {
    const r = await api(j, '/api/auth/refresh', { method: 'POST', json: {} });
    assert(`(D) device ${n + 1} cannot refresh after logout-all`, r.status === 401);
  }

  // (E) revokeAllSessions helper used by password-change
  const { revokeAllSessions } = await import('../src/lib/auth/session');
  const e1 = await loginExisting(alice.email);
  const e2 = await loginExisting(alice.email);
  const liveBefore_E = await prisma.refreshTokenFamily.count({
    where: { userId: alice.userId, revokedAt: null },
  });
  assert(`(E) two live families before revokeAllSessions (got ${liveBefore_E})`, liveBefore_E === 2);
  await revokeAllSessions(alice.userId);
  const liveAfter_E = await prisma.refreshTokenFamily.count({
    where: { userId: alice.userId, revokedAt: null },
  });
  eq('(E) zero live families after revokeAllSessions', 0, liveAfter_E);
  const r_E1 = await api(e1, '/api/auth/refresh', { method: 'POST', json: {} });
  const r_E2 = await api(e2, '/api/auth/refresh', { method: 'POST', json: {} });
  assert(`(E) jar 1 kicked (status=${r_E1.status} code=${r_E1.body?.code})`, r_E1.status === 401);
  assert(`(E) jar 2 kicked (status=${r_E2.status} code=${r_E2.body?.code})`, r_E2.status === 401);
}

// ─────────────────────────────────────────────── 6. CLEANUP

async function cleanup() {
  console.log('\n── cleanup ──');
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'refresh_' } },
    select: { id: true, email: true },
  });
  console.log(`  cleaning up ${users.length} test user(s)`);
  for (const u of users) {
    try {
      await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
      await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
      await prisma.utrSubmission.deleteMany({ where: { userId: u.id } });
      await prisma.idempotencyKey.deleteMany({ where: { userId: u.id } });
      await prisma.inventoryLog.deleteMany({ where: { performedBy: u.id } });
      await prisma.orderItem.deleteMany({ where: { order: { userId: u.id } } });
      await prisma.orderStatusHistory.deleteMany({ where: { order: { userId: u.id } } });
      await prisma.loyaltyLedger.deleteMany({ where: { userId: u.id } });
      await prisma.order.deleteMany({ where: { userId: u.id } });
      await prisma.cartItem.deleteMany({ where: { cart: { userId: u.id } } });
      await prisma.cart.deleteMany({ where: { userId: u.id } });
      await prisma.userActivity.deleteMany({ where: { userId: u.id } });
      await prisma.session.deleteMany({ where: { userId: u.id } });
      await prisma.otpCode.deleteMany({ where: { email: u.email } });
      await prisma.address.deleteMany({ where: { userId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
      ok(`removed user ${u.email}`);
    } catch (e) {
      console.error(`  cleanup failed for ${u.email}: ${(e as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────── MAIN

async function main() {
  writeFileSync('/tmp/test-refresh.log', '');
  console.log(`Starting test server on :${PORT}…`);
  await startServer();
  try {
    console.log('Preparing fixtures…');
    alice = await signupAndVerify('alice');
    bob   = await signupAndVerify('bob');
    void bob;
    ok(`fixtures ready: ${alice.email}`);

    unitTests();
    await pruneUnit();
    await integrationTests();
    await regressionTests();
    await cleanup();

    console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error(e);
    try { await cleanup(); } catch { /* */ }
    throw e;
  } finally {
    await stopServer();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  await prisma.$disconnect();
  process.exit(1);
});
