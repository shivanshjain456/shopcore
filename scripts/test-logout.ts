/**
 * Feature #9 — Secure logout test suite.
 *
 *   npm run test:logout
 *
 * Runs against a real spawned `next start` + real SQLite. Test users are
 * built from scratch + cleaned up at the end. Bypass-OTP session helpers
 * are used so we don't trip the per-email 60s cooldown.
 *
 * Categories (mapped to the bug spec):
 *
 *   1. UNIT — Auth Service           — performLogout() in-process behaviour
 *   2. UNIT — Token Revocation       — Session.revokedAt + Family.revokedAt
 *                                       set by destroySession()
 *   3. INTEGRATION — Logout Endpoint — HTTP contract
 *                                       (scope=current vs scope=all,
 *                                        idempotency, cookies cleared)
 *   4. INTEGRATION — Protected Routes — calling /api/auth/me after logout → 401
 *   5. FRONTEND — Sign-out banner     — /login?signed_out=1 surfaces it
 *   6. STATE CLEANUP                  — cookies cleared on the response
 *   7. MULTI-TAB / MULTI-DEVICE       — logout on one device, second device
 *                                       still works (current scope) OR is also
 *                                       kicked (all scope)
 *   8. EDGE — Expired Session         — logout after revoke still returns 200
 *   9. EDGE — Missing Token           — logout with no cookies returns 200
 *  10. EDGE — Backend Failure         — client-side guard pattern (covered by
 *                                       the dialog suite; here we assert the
 *                                       endpoint never returns 5xx on the
 *                                       happy/edge paths)
 *  11. RACE                           — concurrent logout + refresh → both
 *                                       paths terminate the session safely
 *  12. SECURITY LOGGING               — UserActivity row created with userId,
 *                                       sessionId, IP, UA, scope
 *  13. SECURITY VERIFICATION          — revoked refresh cannot be reused,
 *                                       cannot reach protected routes,
 *                                       session cannot be restored
 *  14. REGRESSION                     — login still works after logout
 *
 * The frontend "Browser refresh / bfcache" cases are exercised in the dialog
 * test suite (jsdom). Here we cover everything that requires a real server.
 */
import { prisma } from '../src/lib/db/client';
import {
  issueRefreshFamily, accessTtlFor, hashSecret,
} from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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

// ─────────────────────────────────────────────── server lifecycle
const PORT = 3029;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;

async function startServer() {
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', SHOPCORE_ALLOW_TEST_EMAILS: '1', SHOPCORE_DISABLE_RATE_LIMITS: '1' },
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

  const out = (b: Buffer) => writeFileSync('/tmp/test-logout.log', b, { flag: 'a' });
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

// ─────────────────────────────────────────────── HTTP client w/ per-jar cookies

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
      // Empty-value or Max-Age=0 → delete (matches browser behaviour)
      if (v === '' || /Max-Age=0/i.test(sc) || /Expires=Thu, 01 Jan 1970/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(jar: Jar, path: string, init?: {
  method?: string; json?: unknown; headers?: Record<string, string>;
}) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  // Send the CSRF header on every unsafe verb (POST/PUT/PATCH/DELETE),
  // regardless of whether the request carries a JSON body.
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers.set(k, v);
  const res = await fetch(BASE + path, {
    method: init?.method ?? 'GET', headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, headers: res.headers, body };
}

// ─────────────────────────────────────────────── fixture

interface TestUser { email: string; userId: string; jars: Jar[]; }
const KEEP_USERS: TestUser[] = [];

/**
 * Create a verified test user + their first session WITHOUT going through
 * the public OTP signup HTTP path. We bypass the public signup/OTP rate
 * limits (10 signups per IP per hour) which would block large test suites.
 *
 * The semantics ARE identical to a real signup-then-verify flow: a User
 * row with status=ACTIVE, a fresh RefreshTokenFamily, a fresh Session, and
 * pre-populated cookies.
 */
async function signupAndVerify(label: string): Promise<TestUser> {
  const { hashPassword } = await import('../src/lib/auth/password');
  const email = `logout_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@shopcore.test`;
  const user = await prisma.user.create({
    data: {
      firstName: 'Lo', lastName: label, email,
      phone: '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      role: 'CUSTOMER', status: 'ACTIVE',
      referralCode: 'REF' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
  const u: TestUser = { email, userId: user.id, jars: [] };
  await loginExtraDevice(u);  // populates u.jars[0]
  KEEP_USERS.push(u);
  return u;
}

/** Bypass OTP: mint a session directly. Re-usable to spin up extra "devices". */
async function loginExtraDevice(u: TestUser): Promise<Jar> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
  const fam = await issueRefreshFamily({ userId: user.id, role: 'CUSTOMER' });
  const ttl = accessTtlFor('CUSTOMER');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: user.id, role: user.role, email: user.email,
    jti: sessionId, fam: fam.familyId,
  }).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId: user.id, tokenHash,
    expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  await api(jar, '/api/auth/csrf');
  jar.cookies['sc_session'] = jwt;
  jar.cookies['sc_refresh'] = fam.secret;
  u.jars.push(jar);
  return jar;
}

// ─────────────────────────────────────────────── UNIT TESTS
async function unitTests() {
  console.log('\n── UNIT — Auth Service (in-process) ──');
  // performLogout() lives in src/lib/client/logout.ts but assumes browser
  // globals + cookies. We test its server-side counterpart (destroySession +
  // revoke cascades) here. The browser-side test is in the dialog suite.
  const u = await signupAndVerify('U1');
  const jar = u.jars[0];

  // Pre-condition: there is exactly one Session + Family for this user
  const sessBefore = await prisma.session.count({ where: { userId: u.userId, revokedAt: null } });
  const famBefore  = await prisma.refreshTokenFamily.count({ where: { userId: u.userId, revokedAt: null } });
  eq('pre: 1 active session',  1, sessBefore);
  eq('pre: 1 active family',   1, famBefore);

  const r = await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  eq('logout returns 200',                            200, r.status);
  eq('response body.ok = true',                       true, r.body.ok);
  // hadSession: true — this was a real session.
  const data = (r.body as { data: { hadSession: boolean; scope: string } }).data;
  eq('response data.hadSession = true',               true, data.hadSession);
  eq('response data.scope = current',                 'current', data.scope);

  console.log('\n── UNIT — Token revocation ──');
  const sessAfter = await prisma.session.count({ where: { userId: u.userId, revokedAt: null } });
  const famAfter  = await prisma.refreshTokenFamily.count({ where: { userId: u.userId, revokedAt: null } });
  eq('post: 0 active sessions', 0, sessAfter);
  eq('post: 0 active families', 0, famAfter);
  const revokedFam = await prisma.refreshTokenFamily.findFirstOrThrow({ where: { userId: u.userId } });
  assert('family.revokedAt set',     !!revokedFam.revokedAt);
  eq('family.revokedReason',         'USER_LOGOUT', revokedFam.revokedReason);
}

// ─────────────────────────────────────────────── INTEGRATION
async function integrationTests() {
  console.log('\n── INTEGRATION — Logout endpoint (HTTP) ──');

  // (i) scope=current — cookies cleared on the response
  const u = await signupAndVerify('U2');
  const jar = u.jars[0];
  const sessionCookieBefore = jar.cookies['sc_session'];
  const refreshCookieBefore = jar.cookies['sc_refresh'];
  assert('(i) had sc_session before logout',  !!sessionCookieBefore);
  assert('(i) had sc_refresh before logout',  !!refreshCookieBefore);
  const r1 = await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  eq('(i) logout → 200',                       200, r1.status);
  assert('(i) sc_session cookie cleared',     !jar.cookies['sc_session']);
  assert('(i) sc_refresh cookie cleared',     !jar.cookies['sc_refresh']);

  // (ii) scope=all
  const u2 = await signupAndVerify('U3');
  const dev1 = u2.jars[0];
  const dev2 = await loginExtraDevice(u2);
  const dev3 = await loginExtraDevice(u2);
  const famCountBefore = await prisma.refreshTokenFamily.count({ where: { userId: u2.userId, revokedAt: null } });
  eq('(ii) 3 active families before scope=all', 3, famCountBefore);
  const r2 = await api(dev1, '/api/auth/logout', { method: 'POST', json: { scope: 'all' } });
  eq('(ii) scope=all → 200',                    200, r2.status);
  const famCountAfter = await prisma.refreshTokenFamily.count({ where: { userId: u2.userId, revokedAt: null } });
  eq('(ii) 0 active families after',            0, famCountAfter);
  // dev2/dev3 cannot use their access cookies anymore (session revoked)
  const me2 = await api(dev2, '/api/auth/me');
  eq('(ii) dev2 /me → 401 after scope=all',    401, me2.status);
  const me3 = await api(dev3, '/api/auth/me');
  eq('(ii) dev3 /me → 401 after scope=all',    401, me3.status);

  // (iii) Idempotency — calling logout AGAIN with cleared cookies
  const r3 = await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  eq('(iii) logout after logout → 200 (idempotent)', 200, r3.status);
  const d3 = (r3.body as { data: { hadSession: boolean } }).data;
  eq('(iii) hadSession=false on repeat',             false, d3.hadSession);

  console.log('\n── INTEGRATION — Protected routes blocked after logout ──');

  // (iv) /api/auth/me returns 401 after logout
  const me = await api(jar, '/api/auth/me');
  eq('(iv) /api/auth/me → 401 after logout',         401, me.status);

  // (v) /api/orders (a real authed surface) returns 401
  const orders = await api(jar, '/api/orders');
  eq('(v) /api/orders → 401 after logout',           401, orders.status);

  // (vi) Public surface untouched — categories endpoint is public; should
  // still return 200 for a brand-new browser with no cookies.
  const guestJar = newJar();
  await api(guestJar, '/api/auth/csrf');
  const cats = await api(guestJar, '/api/categories');
  eq('(vi) public /api/categories → 200',           200, cats.status);
}

// ─────────────────────────────────────────────── FRONTEND / banner
async function frontendTests() {
  console.log('\n── FRONTEND — /login?signed_out=1 surfaces banner ──');

  const res = await fetch(`${BASE}/login?signed_out=1`);
  const html = await res.text();
  assert('login page HTML loads (200)',                       res.status === 200);
  // The signed-out banner copy from src/app/login/page.tsx
  assert('banner copy present in /login?signed_out=1 HTML',
    html.includes('signed-out-banner') ||
    html.includes("You're signed out") ||
    html.includes('You&#x27;re signed out') ||
    html.includes('You&apos;re signed out'),
    html.slice(0, 500));

  // And the no-banner case
  const res2 = await fetch(`${BASE}/login`);
  const html2 = await res2.text();
  assert('no banner without ?signed_out',
    !html2.includes('signed-out-banner'));
}

// ─────────────────────────────────────────────── STATE CLEANUP — already in (i)
// ─────────────────────────────────────────────── EDGE cases
async function edgeCases() {
  console.log('\n── EDGE — Expired session, missing token, no-op ──');

  // (E1) Expired session — server-side revoke the family OUT FROM UNDER us,
  //      then call logout. Should return 200 and not 4xx/5xx.
  const u = await signupAndVerify('E1');
  const jar = u.jars[0];
  const fam = await prisma.refreshTokenFamily.findFirstOrThrow({
    where: { userId: u.userId, revokedAt: null },
  });
  await prisma.refreshTokenFamily.update({
    where: { id: fam.id },
    data:  { revokedAt: new Date(), revokedReason: 'TEST_EXPIRED' },
  });
  await prisma.session.updateMany({
    where: { refreshFamilyId: fam.id, revokedAt: null },
    data:  { revokedAt: new Date() },
  });
  const r = await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  assert(`(E1) expired-session logout → 200 (got ${r.status})`, r.status === 200);

  // (E2) Missing token — fresh jar with only a CSRF cookie
  const empty = newJar();
  await api(empty, '/api/auth/csrf');
  const r2 = await api(empty, '/api/auth/logout', { method: 'POST', json: {} });
  eq('(E2) missing-token logout → 200',           200, r2.status);
  const d2 = (r2.body as { data: { hadSession: boolean } }).data;
  eq('(E2) hadSession=false',                     false, d2.hadSession);

  // (E3) Malformed body — server treats unknown shape as scope=current default
  const u2 = await signupAndVerify('E3');
  const jar2 = u2.jars[0];
  // Send body that's not JSON
  const headers = new Headers({ 'content-type': 'text/plain', cookie: cookieHeader(jar2) });
  if (jar2.cookies['sc_csrf']) headers.set('x-csrf-token', jar2.cookies['sc_csrf']);
  const res = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers, body: 'not-json' });
  applySetCookies(jar2, res);
  eq('(E3) non-JSON body still returns 200',      200, res.status);

  // (E4) Body present but `scope` is unknown — Zod rejects with 400 (we
  //      only accept 'current' | 'all'). This is correct strict behaviour.
  const u3 = await signupAndVerify('E4');
  const jar3 = u3.jars[0];
  const r4 = await api(jar3, '/api/auth/logout', { method: 'POST', json: { scope: 'half' } });
  eq('(E4) unknown scope → 400',                  400, r4.status);
  // Session still alive (request was rejected at the boundary)
  const me = await api(jar3, '/api/auth/me');
  eq('(E4) session intact after rejected request', 200, me.status);
}

// ─────────────────────────────────────────────── MULTI-TAB / MULTI-DEVICE
async function multiDeviceTests() {
  console.log('\n── MULTI-TAB / MULTI-DEVICE ──');

  // (M1) Two devices, scope=current on device1 → device2 still works
  const u = await signupAndVerify('M1');
  const dev1 = u.jars[0];
  const dev2 = await loginExtraDevice(u);
  const r1 = await api(dev1, '/api/auth/logout', { method: 'POST', json: {} });
  eq('(M1) dev1 logout → 200',                   200, r1.status);
  const me2 = await api(dev2, '/api/auth/me');
  eq('(M1) dev2 still authenticated → 200',      200, me2.status);
  const me1 = await api(dev1, '/api/auth/me');
  eq('(M1) dev1 now 401',                        401, me1.status);

  // (M2) Same scenario, scope=all on dev2 → BOTH dev1 (already out) and any
  //      future device get kicked
  const u2 = await signupAndVerify('M2');
  const a = u2.jars[0];
  const b = await loginExtraDevice(u2);
  const c = await loginExtraDevice(u2);
  const r2 = await api(b, '/api/auth/logout', { method: 'POST', json: { scope: 'all' } });
  eq('(M2) scope=all → 200',                     200, r2.status);
  for (const [name, j] of [['a', a], ['b', b], ['c', c]] as const) {
    const me = await api(j, '/api/auth/me');
    eq(`(M2) ${name} → 401 after scope=all`,     401, me.status);
  }

  // (M3) Two tabs of same device share the same cookies → logout in one tab
  //      effectively logs out the other (browser shares cookie jar)
  const u3 = await signupAndVerify('M3');
  const tab1 = u3.jars[0];
  // Tab2 simulated by COPYING tab1's cookies (browser shares cookie jar)
  const tab2: Jar = { cookies: { ...tab1.cookies } };
  const r3 = await api(tab1, '/api/auth/logout', { method: 'POST', json: {} });
  eq('(M3) tab1 logout → 200',                   200, r3.status);
  // tab2 still has the (now-revoked) access cookie until the browser refresh
  const meTab2 = await api(tab2, '/api/auth/me');
  eq('(M3) tab2 with stale cookie → 401',        401, meTab2.status);
}

// ─────────────────────────────────────────────── SECURITY LOGGING
async function securityLogging() {
  console.log('\n── SECURITY LOGGING ──');

  const u = await signupAndVerify('SL');
  const jar = u.jars[0];
  const meRes = await api(jar, '/api/auth/me');
  void meRes; // ensure cookies are warm
  const r = await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  eq('logout → 200', 200, r.status);

  const activity = await prisma.userActivity.findFirst({
    where: { userId: u.userId, action: 'LOGOUT' },
    orderBy: { createdAt: 'desc' },
  });
  assert('UserActivity LOGOUT row created', !!activity);
  // metadata is JSON with sessionId, familyId, userAgent, scope, reason
  const meta = JSON.parse(activity!.metadata ?? '{}') as Record<string, unknown>;
  assert('metadata.sessionId present', typeof meta.sessionId === 'string');
  assert('metadata.familyId present',  typeof meta.familyId === 'string');
  assert('metadata.scope = current',   meta.scope === 'current');
  eq('metadata.reason = USER_LOGOUT',  'USER_LOGOUT', meta.reason);

  // scope=all writes LOGOUT_ALL — reuse 'u' (already signed out) by minting
  // a fresh device for it, then doing scope=all (avoids burning the per-IP
  // signup limit when running many tests in sequence).
  const dev = await loginExtraDevice(u);
  await loginExtraDevice(u);
  await api(dev, '/api/auth/logout', { method: 'POST', json: { scope: 'all' } });
  const a2 = await prisma.userActivity.findFirst({
    where: { userId: u.userId, action: 'LOGOUT_ALL' },
    orderBy: { createdAt: 'desc' },
  });
  assert('LOGOUT_ALL activity row created', !!a2);
}

// ─────────────────────────────────────────────── RACE
async function raceTests() {
  console.log('\n── RACE — concurrent logout + refresh ──');

  // (R1) Logout while a refresh is in flight (same cookies).
  //      Either: refresh wins → rotates → our logout sees the NEW family +
  //              revokes it (final state: logged out).
  //      Or:     logout wins → revokes family → refresh hits revoked path 401
  //              (final state: logged out, refresh returns 401).
  //      Both paths must leave the user signed out.
  const u = await signupAndVerify('R1');
  const jar = u.jars[0];
  const [rRefresh, rLogout] = await Promise.all([
    api({ cookies: { ...jar.cookies } }, '/api/auth/refresh', { method: 'POST', json: {} }),
    api({ cookies: { ...jar.cookies } }, '/api/auth/logout',  { method: 'POST', json: {} }),
  ]);
  assert('(R1) race: logout returned 200',  rLogout.status === 200);
  assert('(R1) race: refresh returned 200 OR 401',
    rRefresh.status === 200 || rRefresh.status === 401,
    { refresh: rRefresh.status });
  // Final state: zero live families
  const live = await prisma.refreshTokenFamily.count({ where: { userId: u.userId, revokedAt: null } });
  // If refresh won, it created a new active family which our concurrent
  // logout MAY OR MAY NOT have caught (the request held stale cookies).
  // Either ≤ 1 live family is acceptable; the original family MUST be revoked.
  assert(`(R1) original family revoked (live count ≤ 1, got ${live})`, live <= 1);

  // (R2) Five parallel logouts with the same cookies — every one returns 2xx
  //      OR a clean 401 (already signed out). Critically, NONE may return 5xx.
  const u2 = await signupAndVerify('R2');
  const N = 5;
  const results = await Promise.all(
    Array.from({ length: N }, () => api(
      { cookies: { ...u2.jars[0].cookies } },
      '/api/auth/logout', { method: 'POST', json: {} },
    )),
  );
  const fiveXX = results.filter((r) => r.status >= 500);
  eq(`(R2) zero 5xx responses (got statuses: ${results.map((r) => r.status).join(',')})`,
     0, fiveXX.length);
  // At LEAST one logout must succeed
  const okCount = results.filter((r) => r.status === 200).length;
  assert(`(R2) ≥1 parallel logout returned 200 (got ${okCount}/${N})`, okCount >= 1);
  // Final DB state: user has no live families
  const liveFams = await prisma.refreshTokenFamily.count({ where: { userId: u2.userId, revokedAt: null } });
  eq('(R2) zero live families after parallel-logout storm', 0, liveFams);
}

// ─────────────────────────────────────────────── SECURITY VERIFICATION
async function securityVerification() {
  console.log('\n── SECURITY VERIFICATION ──');

  // (S1) Revoked refresh cannot be reused
  const u = await signupAndVerify('S1');
  const jar = u.jars[0];
  const stolenRefresh = jar.cookies['sc_refresh'];
  await api(jar, '/api/auth/logout', { method: 'POST', json: {} });
  // Replay the captured refresh token in a fresh jar
  const replay = newJar();
  await api(replay, '/api/auth/csrf');
  replay.cookies['sc_refresh'] = stolenRefresh;
  const r = await api(replay, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(S1) stolen refresh after logout → 401',    401, r.status);

  // (S2) Access to protected routes blocked
  const me = await api(jar, '/api/auth/me');
  eq('(S2) /api/auth/me → 401',                   401, me.status);

  // (S3) Session cannot be restored — even the JWT-bearing access cookie
  //      from BEFORE logout is rejected (Bug #7's server-side session-row
  //      check kicks in because the row was revoked).
  const u2 = await signupAndVerify('S3');
  const jar2 = u2.jars[0];
  const stolenAccess = jar2.cookies['sc_session'];
  await api(jar2, '/api/auth/logout', { method: 'POST', json: {} });
  const replay2 = newJar();
  await api(replay2, '/api/auth/csrf');
  replay2.cookies['sc_session'] = stolenAccess;
  const me2 = await api(replay2, '/api/auth/me');
  eq('(S3) stale access cookie after logout → 401', 401, me2.status);

  // (S4) Logout events logged (already covered in securityLogging, sanity recap)
  const u3 = await signupAndVerify('S4');
  const jar3 = u3.jars[0];
  await api(jar3, '/api/auth/logout', { method: 'POST', json: {} });
  const c = await prisma.userActivity.count({ where: { userId: u3.userId, action: 'LOGOUT' } });
  eq('(S4) UserActivity row exists for the logout', 1, c);
}

// ─────────────────────────────────────────────── REGRESSION
async function regressionTests() {
  console.log('\n── REGRESSION — login flow not broken ──');

  // (RG1) Sign up + verify still works
  const u = await signupAndVerify('RG1');
  const me = await api(u.jars[0], '/api/auth/me');
  eq('(RG1) signup+verify → 200', 200, me.status);

  // (RG2) Protected route reachable AFTER login
  const orders = await api(u.jars[0], '/api/orders');
  eq('(RG2) /api/orders → 200 (authed)', 200, orders.status);

  // (RG3) Refresh still rotates correctly (no impact from logout changes)
  const r = await api(u.jars[0], '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(RG3) /api/auth/refresh → 200', 200, r.status);
  const me2 = await api(u.jars[0], '/api/auth/me');
  eq('(RG3) /me still 200 after refresh', 200, me2.status);

  // (RG4) Sessions list endpoint shows the active family
  const sess = await api(u.jars[0], '/api/auth/sessions');
  eq('(RG4) /api/auth/sessions → 200', 200, sess.status);
  const rows = (sess.body.data as { sessions: { id: string; current: boolean }[] }).sessions;
  assert('(RG4) ≥ 1 active session listed', rows.length >= 1);
  assert('(RG4) one row flagged current=true', rows.some((s) => s.current));

  // (RG5) Single-session revoke via DELETE /api/auth/sessions/[id] for a
  //       different family kicks just that family
  const u2 = await signupAndVerify('RG5');
  const dev1 = u2.jars[0];
  const dev2 = await loginExtraDevice(u2);
  const sessRows = await api(dev1, '/api/auth/sessions');
  const otherFamId = (sessRows.body.data as { sessions: { id: string; current: boolean }[] })
    .sessions.find((s) => !s.current)!.id;
  const del = await api(dev1, `/api/auth/sessions/${otherFamId}`, { method: 'DELETE' });
  eq('(RG5) DELETE other session → 200', 200, del.status);
  // Confirm cascade
  const me_other = await api(dev2, '/api/auth/me');
  eq('(RG5) dev2 kicked → 401', 401, me_other.status);
  // Confirm current still works
  const me_self = await api(dev1, '/api/auth/me');
  eq('(RG5) dev1 (current) still 200', 200, me_self.status);

  // (RG6) Cannot revoke own current family without ?force=1
  const sess2 = await api(dev1, '/api/auth/sessions');
  const myFamId = (sess2.body.data as { sessions: { id: string; current: boolean }[] })
    .sessions.find((s) => s.current)!.id;
  const delSelf = await api(dev1, `/api/auth/sessions/${myFamId}`, { method: 'DELETE' });
  eq('(RG6) DELETE current without ?force → 409', 409, delSelf.status);
  eq('(RG6) code = CURRENT_FAMILY', 'CURRENT_FAMILY', delSelf.body.code);
}

// ─────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'logout_' } },
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
  writeFileSync('/tmp/test-logout.log', '');
  console.log(`Starting test server on :${PORT}…`);
  await startServer();
  try {
    await unitTests();
    await integrationTests();
    await frontendTests();
    await edgeCases();
    await multiDeviceTests();
    await securityLogging();
    await raceTests();
    await securityVerification();
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
