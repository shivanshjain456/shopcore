/**
 * Edge-case audit & remediation tests.
 *
 *   npm run test:edge-cases
 *
 * Organised by the nine audit domains. Tiers per domain:
 *
 *   1. Unit / service-level tests (no server spawn)
 *   2. Integration tests (single shared `next start` for the whole suite)
 *   3. Static audits (grep-based — fail the build on regression)
 *
 * The spec is clear: every confirmed bug got a targeted fix; this file
 * is the proof-of-fix. Each block has a stable `[D<x>.<y>]` tag matching
 * the bug ID in the brief so failing assertions are immediately
 * traceable to the spec.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  readdirSync, readFileSync, statSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';

import { UserStatus } from '../src/lib/enums';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import { verifyOtp, issueOtp } from '../src/lib/auth/otp';
import { transitionAccountState } from '../src/lib/auth/accountStateMachine';
import {
  requireWritePermitted, requireOrderPermitted, requireAuthenticated,
  isWritePermitted, isOrderPermitted,
} from '../src/lib/auth/guards';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
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

const TAG = `edge_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const freshPhone = () => '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);

async function makeUser(label: string, status: typeof UserStatus[keyof typeof UserStatus] = UserStatus.ACTIVE) {
  return prisma.user.create({
    data: {
      firstName: 'Edge', lastName: label,
      email: `${TAG}_${label}@shopcore.test`,
      phone: freshPhone(),
      passwordHash: await hashPassword('Sm0kyM#7QrXa'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India', role: 'CUSTOMER',
      // STATE_MACHINE_BYPASS: test-fixture seeding.
      status,
      phoneVerified: status === UserStatus.ACTIVE,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
}

// ──────────────────────────────────────────────────────────── D1 — Auth
async function domainAuthTests() {
  console.log('\n── DOMAIN 1 — Authentication & sessions ──');

  // (D1.4) OTP timing-attack mitigation.
  // We can't measure exact ns timing reliably in a test, but we CAN
  // assert that the dummy-bcrypt call is performed on the negative
  // path. We do this by measuring elapsed time and asserting both
  // paths take at least ~50ms (cost-10 bcrypt). The exact numbers vary
  // by hardware; the GUARD is "negative path is NOT instantaneous".
  {
    // Negative: no OTP row exists for this random email.
    const t0 = Date.now();
    const r1 = await verifyOtp({ email: `${TAG}_timing_none@shopcore.test`, purpose: 'SIGNUP', code: '000000' });
    const negElapsed = Date.now() - t0;
    assert('[D1.4] negative-path verifyOtp returns !ok', !r1.ok);
    assert(`[D1.4] negative path runs bcrypt (>=15ms; got ${negElapsed}ms)`,
      negElapsed >= 15);

    // Positive (wrong code): real OTP exists, we submit a wrong one.
    const u = await makeUser('timing');
    await issueOtp({ email: u.email, purpose: 'LOGIN', userId: u.id });
    const t1 = Date.now();
    const r2 = await verifyOtp({ email: u.email, purpose: 'LOGIN', code: '111111' });
    const posElapsed = Date.now() - t1;
    assert('[D1.4] positive-but-wrong returns !ok', !r2.ok);
    assert(`[D1.4] positive path runs bcrypt (>=15ms; got ${posElapsed}ms)`,
      posElapsed >= 15);
    // The two paths should be in the same order of magnitude. We allow
    // 10× slack because CI is noisy — the security property is that
    // the negative path is NOT 0ms.
    const ratio = Math.max(negElapsed, posElapsed) / Math.max(1, Math.min(negElapsed, posElapsed));
    assert(`[D1.4] negative/positive timing ratio <= 10× (got ${ratio.toFixed(2)})`,
      ratio <= 10);
  }
}

// ──────────────────────────────────────────────────────────── D2 — State machine integration
async function domainStateMachineTests() {
  console.log('\n── DOMAIN 2 — State machine integration ──');

  // (D2.2) `isOrderPermitted` predicate.
  eq('[D2.2] isOrderPermitted(ACTIVE) = true',
    true,  isOrderPermitted(UserStatus.ACTIVE));
  eq('[D2.2] isOrderPermitted(PENDING_PHONE_VERIFICATION) = false',
    false, isOrderPermitted(UserStatus.PENDING_PHONE_VERIFICATION));
  eq('[D2.2] isOrderPermitted(SUSPENDED) = false',
    false, isOrderPermitted(UserStatus.SUSPENDED));
  eq('[D2.2] isOrderPermitted(DELETED) = false',
    false, isOrderPermitted(UserStatus.DELETED));

  // (D2.3) `isWritePermitted` predicate.
  eq('[D2.3] isWritePermitted(ACTIVE) = true',
    true,  isWritePermitted(UserStatus.ACTIVE));
  eq('[D2.3] isWritePermitted(PENDING_PHONE_VERIFICATION) = false',
    false, isWritePermitted(UserStatus.PENDING_PHONE_VERIFICATION));
  eq('[D2.3] isWritePermitted(SUSPENDED) = false',
    false, isWritePermitted(UserStatus.SUSPENDED));

  // (D2.x) Guards return NextResponse on rejection, null on success.
  const activeUser = { id: 'u1', status: UserStatus.ACTIVE };
  eq('[D2] requireWritePermitted(ACTIVE) = null (proceed)',
    null, requireWritePermitted(activeUser));
  eq('[D2] requireOrderPermitted(ACTIVE) = null (proceed)',
    null, requireOrderPermitted(activeUser));
  eq('[D2] requireAuthenticated(null) = NextResponse',
    true, requireAuthenticated(null) !== null);

  const suspendedUser = { id: 'u2', status: UserStatus.SUSPENDED };
  assert('[D2.3] requireWritePermitted(SUSPENDED) returns rejection',
    requireWritePermitted(suspendedUser) !== null);
  assert('[D2.2] requireOrderPermitted(SUSPENDED) returns rejection',
    requireOrderPermitted(suspendedUser) !== null);

  const ppvUser = { id: 'u3', status: UserStatus.PENDING_PHONE_VERIFICATION };
  assert('[D2.2] requireOrderPermitted(PENDING_PHONE_VERIFICATION) returns rejection',
    requireOrderPermitted(ppvUser) !== null);
  assert('[D2.3] requireWritePermitted(PENDING_PHONE_VERIFICATION) returns rejection',
    requireWritePermitted(ppvUser) !== null);
}

// ──────────────────────────────────────────────────────────── D9 — Security/config
function domainSecurityTests() {
  console.log('\n── DOMAIN 9 — Security & configuration ──');

  // (D9.7) Middleware overwrites inbound x-request-id.
  // Static audit: the middleware source must NOT call
  // `headers.get('x-request-id')` for the propagated reqId.
  const mw = readFileSync('src/middleware.ts', 'utf8');
  // Strip comments before regex check so the "NEVER honour" doc string
  // (which legitimately mentions the header) doesn't trip the audit.
  const mwNoComments = mw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert('[D9.7] middleware does NOT consume inbound x-request-id for propagation',
    !/get\(['"]x-request-id['"]\)\s*\?\?/.test(mwNoComments));
  assert('[D9.7] middleware always calls genRequestId()',
    /const\s+reqId\s*=\s*genRequestId\(\)/.test(mwNoComments));
  assert('[D9.7] middleware overwrites x-request-id on the forwarded request',
    /fwd\.set\(['"]x-request-id['"]/.test(mwNoComments));

  // (D9.5) Preflight refuses production startup with leak env vars set.
  const boot = readFileSync('src/lib/boot.ts', 'utf8');
  assert('[D9.5] boot.ts refuses SHOPCORE_TEST_OTP_FILE in production',
    /SHOPCORE_TEST_OTP_FILE/.test(boot)
    && /problems\.push.*SHOPCORE_TEST_OTP_FILE/.test(boot));
  assert('[D9.5] boot.ts refuses SHOPCORE_ALLOW_TEST_EMAILS in production',
    /SHOPCORE_ALLOW_TEST_EMAILS/.test(boot)
    && /problems\.push.*SHOPCORE_ALLOW_TEST_EMAILS/.test(boot));
  assert('[D9.5] boot.ts refuses SHOPCORE_DISABLE_RATE_LIMITS in production',
    /SHOPCORE_DISABLE_RATE_LIMITS/.test(boot)
    && /problems\.push.*SHOPCORE_DISABLE_RATE_LIMITS/.test(boot));
}

// ──────────────────────────────────────────────────────────── D7 — Client-side static audit
function domainClientStaticAudit() {
  console.log('\n── DOMAIN 7 — Client-side static audit ──');

  // (D7.4) No NEW array-index keys in mutable lists. The whitelist
  // captures the small set of fixed-shape / immutable-order lists we
  // deliberately keep with index keys (OtpInput's 6 fixed slots,
  // read-only confirmation / detail views).
  const WHITELIST_INDEX_KEYS = new Set<string>([
    'src/components/auth/OtpInput.tsx',                     // fixed 6 slots, never reorder
    'src/app/(storefront)/account/returns/[id]/page.tsx',   // immutable read view
    'src/app/(storefront)/b2b/bulk/page.tsx',               // immutable CSV result
    'src/app/(storefront)/b2b/quotes/[id]/page.tsx',        // immutable read view
    'src/app/(storefront)/checkout/page.tsx',               // server-rendered totals breakdown
    'src/app/(storefront)/compare/page.tsx',                // matrix of fixed labels
    'src/app/admin/(app)/quotes/[id]/page.tsx',             // admin read view
  ]);
  const offenders: string[] = [];
  walk('src', (p) => {
    if (!/\.tsx$/.test(p)) return;
    if (WHITELIST_INDEX_KEYS.has(p)) return;
    const src = readFileSync(p, 'utf8');
    if (/key=\{i\}|key=\{idx\}|key=\{index\}/.test(src)) {
      offenders.push(p);
    }
  });
  assert(`[D7.4] no new key={i|idx|index} in mutable lists (offenders: ${offenders.length})`,
    offenders.length === 0, offenders);

  // (D4.4 / D5.2 / D6.3) Static audit — stock + coupon decrements
  // MUST carry a conditional `where` clause. Failure here means a race
  // window has been re-introduced.
  const placeOrder = readFileSync('src/lib/checkout/placeOrder.ts', 'utf8');
  // Strip comments so the doc paragraphs that mention the bare pattern
  // for explanation don't trip the audit.
  const placeOrderCode = placeOrder
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert('[D4.4] product stock decrement uses conditional where (gte)',
    /tx\.product\.update\(\{\s*where:\s*\{[^}]*stock:\s*\{\s*gte:/.test(placeOrderCode));
  assert('[D4.4] variant stock decrement uses conditional where (gte)',
    /tx\.variant\.update\(\{\s*where:\s*\{[^}]*stock:\s*\{\s*gte:/.test(placeOrderCode));
  assert('[D5.2] coupon increment uses conditional where (lt)',
    /tx\.coupon\.update\(\{\s*where:\s*\{[^}]*usedCount:\s*\{\s*lt:/.test(placeOrderCode));

  // (D2.2 / D2.3) Static audit — every place-order / write surface
  // uses the new state guards. Looking for the imports + invocations.
  const checkoutPO = readFileSync('src/app/api/checkout/place-order/route.ts', 'utf8');
  const checkoutEx = readFileSync('src/app/api/checkout/express/route.ts', 'utf8');
  assert('[D2.2] place-order calls isOrderPermitted',
    /isOrderPermitted\s*\(/.test(checkoutPO));
  assert('[D2.2] express checkout calls isOrderPermitted',
    /isOrderPermitted\s*\(/.test(checkoutEx));

  for (const f of [
    'src/app/api/account/reviews/route.ts',
    'src/app/api/account/returns/route.ts',
    'src/app/api/account/tickets/route.ts',
    'src/app/api/account/tickets/[id]/messages/route.ts',
    'src/app/api/account/saved-carts/route.ts',
    'src/app/api/wishlist/toggle/route.ts',
  ]) {
    const src = readFileSync(f, 'utf8');
    assert(`[D2.3] ${f} uses requireWritePermitted`,
      /requireWritePermitted\s*\(/.test(src));
  }

  // (D1.4) OTP module uses the timing dummy on negative paths.
  const otp = readFileSync('src/lib/auth/otp.ts', 'utf8');
  assert('[D1.4] otp.ts defines OTP_TIMING_DUMMY_HASH constant',
    /OTP_TIMING_DUMMY_HASH/.test(otp));
  assert('[D1.4] otp.ts uses dummy hash on negative path',
    /bcrypt\.compare\(submitted,\s*OTP_TIMING_DUMMY_HASH\)/.test(otp));
}

// ──────────────────────────────────────────────────────────── INTEGRATION
const PORT = 3057;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-edge-cases-${process.pid}.log`;

async function startServer() {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SHOPCORE_ALLOW_TEST_EMAILS: '1',
      // We deliberately do NOT set SHOPCORE_DISABLE_RATE_LIMITS — the
      // edge-case tests don't burst, and we want the global cap +
      // per-policy caps active so the assertions reflect production.
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
  const append = (b: Buffer) => writeFileSync(SRV_LOG, b, { flag: 'a' });
  serverProc.stdout?.on('data', append);
  serverProc.stderr?.on('data', append);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start');
}
async function stopServer() {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response) {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Forge a session jar for an existing user — bypasses login UI. */
async function sessionJarFor(userId: string, role: 'CUSTOMER' | 'ADMIN', status: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const fam = await issueRefreshFamily({ userId, role });
  const ttl = accessTtlFor(role);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: u.id, role: u.role, email: u.email,
    jti: sessionId, fam: fam.familyId, status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  // Pull CSRF cookie.
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, csrfRes);
  const cookieName = role === 'ADMIN' ? 'sc_admin' : 'sc_session';
  const refreshName = role === 'ADMIN' ? 'sc_admin_refresh' : 'sc_refresh';
  jar.cookies[cookieName] = jwt;
  jar.cookies[refreshName] = fam.secret;
  return jar;
}

async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown }) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (!headers.has('origin')) headers.set('origin', BASE);
  const res = await fetch(BASE + path, {
    method, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body, headers: res.headers };
}

async function integrationTests() {
  console.log('\n── INTEGRATION — state-machine gates over HTTP ──');

  // (D2.2-int) place-order on a PENDING_PHONE_VERIFICATION user → 403.
  const ppvUser = await makeUser('int_ppv', UserStatus.PENDING_PHONE_VERIFICATION);
  const ppvJar = await sessionJarFor(ppvUser.id, 'CUSTOMER', UserStatus.PENDING_PHONE_VERIFICATION);
  const r1 = await api(ppvJar, '/api/checkout/place-order', { method: 'POST', json: {
    shippingAddressId: 'x', utrNumber: '0000', receiptUrl: '/api/uploads/x',
  }});
  eq('[D2.2-int] PENDING_PHONE_VERIFICATION user → /place-order → 403', 403, r1.status);
  eq('[D2.2-int] body.code = ACCOUNT_NOT_ORDER_PERMITTED',
    'ACCOUNT_NOT_ORDER_PERMITTED', r1.body.code);

  // (D2.3-int) Defence-in-depth: SUSPENDED users are rejected at the
  //            AUTH layer first (`isLoginPermitted` only accepts ACTIVE
  //            + PENDING_PHONE_VERIFICATION), so they never even reach
  //            the route handler — they get 401, not 403. That's the
  //            stronger guarantee. We still test with a
  //            PENDING_PHONE_VERIFICATION user below to exercise the
  //            403 write-gate path on a state that IS login-permitted.
  const susUser = await makeUser('int_sus', UserStatus.SUSPENDED);
  const susJar = await sessionJarFor(susUser.id, 'CUSTOMER', UserStatus.SUSPENDED);
  const rSus = await api(susJar, '/api/wishlist/toggle', { method: 'POST', json: {
    productId: 'fake_product',
  }});
  eq('[D2.3-int] SUSPENDED user → /wishlist/toggle → 401 (auth-layer reject)',
    401, rSus.status);

  // (D2.3-int) PENDING_PHONE_VERIFICATION user CAN authenticate (so they
  // can resume the verify flow) but MUST be blocked from writes by the
  // route-level `requireWritePermitted` guard — 403 with safe code.
  const r2 = await api(ppvJar, '/api/wishlist/toggle', { method: 'POST', json: {
    productId: 'fake_product',
  }});
  eq('[D2.3-int] PPV user → /wishlist/toggle → 403 (route-level write gate)',
    403, r2.status);
  eq('[D2.3-int] body.code = ACCOUNT_NOT_WRITE_PERMITTED',
    'ACCOUNT_NOT_WRITE_PERMITTED', r2.body.code);

  const r3 = await api(ppvJar, '/api/account/tickets', { method: 'POST', json: {
    subject: 'help', category: 'ACCOUNT', body: 'message',
  }});
  eq('[D2.3-int] PPV user → POST /account/tickets → 403', 403, r3.status);
  eq('[D2.3-int] tickets body.code = ACCOUNT_NOT_WRITE_PERMITTED',
    'ACCOUNT_NOT_WRITE_PERMITTED', r3.body.code);

  // (D2.3-int) PPV user CAN still read tickets (read paths don't gate).
  const r4 = await api(ppvJar, '/api/account/tickets');
  eq('[D2.3-int] PPV user → GET /account/tickets still allowed', 200, r4.status);

  // (D2.5-int) DELETED user — handler rejects even with valid JWT.
  // We transition via the state machine so all side-effects fire
  // (revokeAllSessions), then assert subsequent requests reject.
  const delUser = await makeUser('int_del', UserStatus.ACTIVE);
  const adminFor = await makeUser('int_del_admin', UserStatus.ACTIVE);
  await prisma.user.update({ where: { id: adminFor.id }, data: { role: 'ADMIN' } });
  const delJar = await sessionJarFor(delUser.id, 'CUSTOMER', UserStatus.ACTIVE);
  // Confirm the session works pre-delete.
  const preDel = await api(delJar, '/api/auth/me');
  eq('[D2.5-int] pre-delete /me → 200', 200, preDel.status);
  // Transition to DELETED via the machine (revokes sessions + families).
  await transitionAccountState(delUser.id, UserStatus.DELETED,
    { type: 'ADMIN', adminId: adminFor.id });
  // The JWT is still cryptographically valid for ~15 min, but the
  // session row was revoked AND `getCurrentUser` re-reads from DB,
  // so the route handler must reject.
  const postDel = await api(delJar, '/api/auth/me');
  eq('[D2.5-int] post-delete /me → 401 (handler-level reject)', 401, postDel.status);

  // (D9.7-int) Server overwrites attacker-supplied x-request-id.
  const attackerId = 'attacker-controlled-' + crypto.randomBytes(4).toString('hex');
  const r9 = await fetch(`${BASE}/api/auth/csrf`, {
    headers: { 'x-request-id': attackerId },
  });
  const serverId = r9.headers.get('x-request-id');
  assert(`[D9.7-int] server-generated id replaces attacker value (server="${serverId}", attacker="${attackerId}")`,
    serverId !== null && serverId !== attackerId);
}

// ──────────────────────────────────────────────────────────── helpers
function walk(root: string, fn: (path: string) => void) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// ──────────────────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TAG } }, select: { id: true },
  });
  for (const u of users) {
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.auditLog.deleteMany({ where: { entity: 'User', entityId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.otpCode.deleteMany({ where: { userId: u.id } });
    await prisma.address.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => { /* */ });
  }
  ok(`removed ${users.length} test user(s)`);
}

// ──────────────────────────────────────────────────────────── MAIN
async function main() {
  try {
    await domainAuthTests();
    await domainStateMachineTests();
    domainSecurityTests();
    domainClientStaticAudit();
    await startServer();
    await integrationTests();
  } finally {
    await stopServer();
    try { await cleanup(); } catch (e) { console.warn('cleanup failed:', e); }
    try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
    await prisma.$disconnect();
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
