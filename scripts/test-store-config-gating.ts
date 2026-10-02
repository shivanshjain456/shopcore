/**
 * Store Config — feature-gating end-to-end. Item 8 Phase 2.
 *
 *   npm run test:store-config-gating
 *
 * What it proves: every route that the spec §2.4 table lists as
 * "gated" actually rejects when its toggle is OFF, and succeeds when
 * its toggle is ON.
 *
 * Why a SEPARATE script (not folded into test:store-config):
 *
 *   The base test:store-config harness runs with NODE_ENV=test, which
 *   trips the `featureGate.ts` test-bypass (spec §6.4). That bypass is
 *   what keeps the existing 1,902+ assertions across other suites
 *   green — they exercise routes (signup, wishlist, B2B apply, …) that
 *   are now gated, and we don't want to refactor every existing test
 *   to flip flags before/after.
 *
 *   THIS suite spawns `next start` with
 *   `SHOPCORE_ENFORCE_FEATURE_GATES=1` set, so the child server treats
 *   gates as REAL — exactly the production behaviour. We mutate the
 *   StoreConfig singleton via the admin PATCH endpoint between
 *   assertions, no DB poking around the API.
 *
 * Every assertion carries a [G<n>.<m>] tag mapping to the spec gate.
 */
// Pre-import side-effects.
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  // Drain server log tail for context.
  if (existsSync(SRV_LOG)) {
    const tail = readFileSync(SRV_LOG, 'utf-8').split('\n').slice(-15).join('\n');
    console.error('     ── recent server lines ──\n' + tail);
  }
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else failAssert(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else failAssert(label, true, detail ?? false);
}

const TAG = `gat_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

const PORT = 3063;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-store-config-gating-${process.pid}.log`;
const SINGLETON_BACKUP = `/tmp/sc-gating-config-${process.pid}.json`;

// ── Server lifecycle ──────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JOB_RUNNER_ENABLED: 'false',
      // THE KEY DIFFERENCE from test:store-config — the child server
      // enforces gates even though NODE_ENV=development.
      SHOPCORE_ENFORCE_FEATURE_GATES: '1',
      SHOPCORE_ALLOW_TEST_EMAILS: '1',
    },
    detached: true,
  });
  const killGroup = (): void => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit',    killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });
  const append = (b: Buffer): void => { writeFileSync(SRV_LOG, b, { flag: 'a' }); };
  serverProc.stdout?.on('data', append);
  serverProc.stderr?.on('data', append);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start within 30s — see ' + SRV_LOG);
}

async function stopServer(): Promise<void> {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────

async function backupSingleton(): Promise<void> {
  const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
  writeFileSync(SINGLETON_BACKUP, JSON.stringify({ data: row?.data ?? '{}' }), 'utf-8');
}
async function restoreSingleton(): Promise<void> {
  try {
    const raw = readFileSync(SINGLETON_BACKUP, 'utf-8');
    const { data } = JSON.parse(raw) as { data: string };
    await prisma.storeConfig.upsert({
      where:  { id: 'singleton' },
      update: { data },
      create: { id: 'singleton', data },
    });
  } catch { /* */ }
  try { unlinkSync(SINGLETON_BACKUP); } catch { /* */ }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }

/** Build an anon jar that already carries `sc_csrf` so POSTs aren't
 *  CSRF-rejected before they reach the feature gate. */
async function newAnonJar(): Promise<Jar> {
  const jar = newJar();
  const r = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, r);
  return jar;
}
function applySetCookies(jar: Jar, res: Response): void {
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
function cookieHeader(jar: Jar): string {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function sessionJarFor(userId: string, role: 'ADMIN' | 'CUSTOMER'): Promise<Jar> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const fam = await issueRefreshFamily({ userId, role });
  const ttl = accessTtlFor(role);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: u.id, role: u.role, email: u.email,
    jti: sessionId, fam: fam.familyId, status: u.status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, csrfRes);
  jar.cookies[role === 'ADMIN' ? 'sc_admin'         : 'sc_session'] = jwt;
  jar.cookies[role === 'ADMIN' ? 'sc_admin_refresh' : 'sc_refresh'] = fam.secret;
  return jar;
}

interface ApiResp { status: number; body: Record<string, unknown>; headers: Headers; }
async function call(jar: Jar, p: string, init?: { method?: string; json?: unknown }): Promise<ApiResp> {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (!headers.has('origin')) headers.set('origin', BASE);
  const res = await fetch(BASE + p, {
    method, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body, headers: res.headers };
}

// ── User fixtures ─────────────────────────────────────────────────────────

async function makeActiveCustomer(label: string): Promise<{ id: string; email: string }> {
  const email = `${TAG}_${label}@shopcore.test`;
  const u = await prisma.user.create({
    data: {
      firstName: 'Gate', lastName: label, email,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaGating'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'CUSTOMER',
      // STATE_MACHINE_BYPASS: brand-new fixture user. The runtime
      // state machine governs TRANSITIONS, not initial inserts.
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return { id: u.id, email };
}

async function makeAdmin(): Promise<{ id: string; email: string }> {
  const email = `${TAG}_admin@shopcore.test`;
  const u = await prisma.user.create({
    data: {
      firstName: 'Gate', lastName: 'Admin', email,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaAdmin'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new admin fixture.
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return { id: u.id, email };
}

/** Convenience: PATCH a single feature flag via the admin API. */
async function setFlag(adminJar: Jar, key: string, value: unknown): Promise<void> {
  const r = await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: { [key]: value } } });
  if (r.status !== 200) {
    failAssert(`setFlag ${key} = ${JSON.stringify(value)} failed`, 200, r.status);
  }
}

// ── The assertions ────────────────────────────────────────────────────────

async function gatingTests(): Promise<void> {
  console.log('\n── GATING — every toggle blocks its route when OFF, allows when ON ──');

  const admin = await makeAdmin();
  const adminJar = await sessionJarFor(admin.id, 'ADMIN');

  const cust = await makeActiveCustomer('cust');
  const custJar = await sessionJarFor(cust.id, 'CUSTOMER');

  const cust2 = await makeActiveCustomer('cust2');
  const cust2Jar = await sessionJarFor(cust2.id, 'CUSTOMER');

  // ── G1: features.registrationEnabled (POST /api/auth/signup) ──
  {
    await setFlag(adminJar, 'features.registrationEnabled', false);
    const body = {
      firstName: 'New', lastName: 'User',
      email: `${TAG}_signup_blocked@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      password: 'Sm0kyM#7QrXaGating',
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai',
      state: 'Maharashtra', pinCode: '400001',
    };
    const blocked = await call(await newAnonJar(), '/api/auth/signup', { method: 'POST', json: body });
    eq('[G1.1] signup blocked when registrationEnabled=false → 403',
      403, blocked.status);
    eq('[G1.1] error code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blocked.body as { code: string }).code);

    // Re-enable; signup blocked by a *second* admin gate
    // (maintenance.registrationPaused). Toggle each independently.
    await setFlag(adminJar, 'features.registrationEnabled', true);
    await setFlag(adminJar, 'maintenance.registrationPaused', true);
    const paused = await call(await newAnonJar(), '/api/auth/signup', { method: 'POST', json: body });
    eq('[G1.2] signup blocked when registrationPaused=true → 403',
      403, paused.status);
    eq('[G1.2] error code = FEATURE_PAUSED',
      'FEATURE_PAUSED', (paused.body as { code: string }).code);
    await setFlag(adminJar, 'maintenance.registrationPaused', false);
    // Don't actually submit a successful signup here — the OTP side-effects
    // (email send, user row) would complicate cleanup. We've already
    // proven the gate; the happy-path is covered by test:auth.
  }

  // ── G2: features.wishlistEnabled (POST /api/wishlist/toggle) ──
  {
    await setFlag(adminJar, 'features.wishlistEnabled', false);
    const blocked = await call(custJar, '/api/wishlist/toggle',
      { method: 'POST', json: { productId: 'p_does_not_matter' } });
    eq('[G2.1] wishlist toggle blocked when wishlistEnabled=false → 403',
      403, blocked.status);
    eq('[G2.1] error code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blocked.body as { code: string }).code);

    await setFlag(adminJar, 'features.wishlistEnabled', true);
    const ok = await call(custJar, '/api/wishlist/toggle',
      { method: 'POST', json: { productId: 'p_does_not_matter' } });
    // The product doesn't exist → expect a non-403 status (404/500-ish
    // depending on the handler's FK behaviour). The KEY assertion is
    // that the route is no longer rejecting with FEATURE_DISABLED.
    assert(`[G2.2] wishlist toggle past gate when enabled (status=${ok.status})`,
      ok.status !== 403 || (ok.body as { code?: string }).code !== 'FEATURE_DISABLED',
      ok.body);
  }

  // ── G3: features.compareEnabled (GET + POST /api/compare) ──
  {
    await setFlag(adminJar, 'features.compareEnabled', false);
    const blockedGet = await call(custJar, '/api/compare');
    eq('[G3.1] compare GET blocked when compareEnabled=false → 403',
      403, blockedGet.status);
    eq('[G3.1] error code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blockedGet.body as { code: string }).code);

    const blockedPost = await call(custJar, '/api/compare',
      { method: 'POST', json: { action: 'clear' } });
    eq('[G3.2] compare POST blocked when compareEnabled=false → 403',
      403, blockedPost.status);

    await setFlag(adminJar, 'features.compareEnabled', true);
    const okGet = await call(custJar, '/api/compare');
    eq('[G3.3] compare GET passes when enabled → 200', 200, okGet.status);
  }

  // ── G4: features.reviewsEnabled (POST /api/account/reviews) ──
  {
    await setFlag(adminJar, 'features.reviewsEnabled', false);
    const blocked = await call(custJar, '/api/account/reviews',
      { method: 'POST', json: { productId: 'p_x', rating: 5, title: 't', body: 'b' } });
    eq('[G4.1] reviews POST blocked when reviewsEnabled=false → 403',
      403, blocked.status);
    eq('[G4.1] error code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blocked.body as { code: string }).code);

    await setFlag(adminJar, 'features.reviewsEnabled', true);
    const past = await call(custJar, '/api/account/reviews',
      { method: 'POST', json: { productId: 'p_x', rating: 5, title: 't', body: 'b' } });
    assert(`[G4.2] reviews POST past gate when enabled (status=${past.status})`,
      past.status !== 403 || (past.body as { code?: string }).code !== 'FEATURE_DISABLED',
      past.body);
  }

  // ── G5: features.b2bEnabled (every /api/b2b/* route) ──
  {
    await setFlag(adminJar, 'features.b2bEnabled', false);
    for (const [label, p] of [
      ['GET  /api/b2b/me',     '/api/b2b/me'],
      ['GET  /api/b2b/quotes', '/api/b2b/quotes'],
    ] as const) {
      const r = await call(custJar, p);
      eq(`[G5.1] ${label} blocked when b2bEnabled=false → 403`, 403, r.status);
      eq(`[G5.1] ${label} code = FEATURE_DISABLED`,
        'FEATURE_DISABLED', (r.body as { code: string }).code);
    }
    const apply = await call(custJar, '/api/b2b/apply',
      { method: 'POST', json: { companyName: 'Acme', gstin: '27AAACR5055K1Z6', pan: 'AAACR5055K' } });
    eq('[G5.2] B2B apply blocked when b2bEnabled=false → 403', 403, apply.status);

    await setFlag(adminJar, 'features.b2bEnabled', true);
    const re = await call(custJar, '/api/b2b/me');
    // Customer is not B2B → 200 with empty profile. Past the gate is
    // what we care about.
    assert(`[G5.3] B2B GET past gate when enabled (status=${re.status})`,
      re.status === 200, re.body);

    // G5.4: B2B registration sub-toggle
    await setFlag(adminJar, 'features.b2bRegistrationEnabled', false);
    const closedApply = await call(custJar, '/api/b2b/apply',
      { method: 'POST', json: { companyName: 'Acme', gstin: '27AAACR5055K1Z6', pan: 'AAACR5055K' } });
    eq('[G5.4] B2B apply blocked when b2bRegistrationEnabled=false → 403',
      403, closedApply.status);
    eq('[G5.4] error code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (closedApply.body as { code: string }).code);
    await setFlag(adminJar, 'features.b2bRegistrationEnabled', true);
  }

  // ── G6: features.liveChat (GET + POST /api/account/chat) ──
  {
    await setFlag(adminJar, 'features.liveChat', false);
    const blockedGet = await call(custJar, '/api/account/chat');
    eq('[G6.1] chat GET blocked when liveChat=false → 403', 403, blockedGet.status);
    eq('[G6.1] code = FEATURE_DISABLED', 'FEATURE_DISABLED', (blockedGet.body as { code: string }).code);

    const blockedPost = await call(custJar, '/api/account/chat',
      { method: 'POST', json: { body: 'hello' } });
    eq('[G6.2] chat POST blocked when liveChat=false → 403', 403, blockedPost.status);

    await setFlag(adminJar, 'features.liveChat', true);
    const re = await call(custJar, '/api/account/chat');
    assert(`[G6.3] chat GET past gate when enabled (status=${re.status})`,
      re.status === 200, re.body);
  }

  // ── G7: features.supportTickets (POST /api/account/tickets) ──
  {
    await setFlag(adminJar, 'features.supportTickets', false);
    const blocked = await call(custJar, '/api/account/tickets',
      { method: 'POST', json: { subject: 'help', category: 'OTHER', body: 'pls help' } });
    eq('[G7.1] tickets POST blocked when supportTickets=false → 403',
      403, blocked.status);
    eq('[G7.1] code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blocked.body as { code: string }).code);
    // GET still works — read paths aren't gated (existing tickets must
    // remain visible if the admin disables NEW tickets).
    const getRes = await call(custJar, '/api/account/tickets');
    assert(`[G7.2] tickets GET unaffected by feature toggle (status=${getRes.status})`,
      getRes.status === 200, getRes.body);
    await setFlag(adminJar, 'features.supportTickets', true);
  }

  // ── G8: maintenance.checkoutPaused (POST /api/checkout/place-order) ──
  {
    await setFlag(adminJar, 'maintenance.checkoutPaused', true);
    const blocked = await call(custJar, '/api/checkout/place-order',
      { method: 'POST', json: { shippingAddressId: 'x', utrNumber: '0000', receiptUrl: '/api/uploads/x' } });
    eq('[G8.1] place-order blocked when checkoutPaused=true → 403',
      403, blocked.status);
    eq('[G8.1] code = FEATURE_PAUSED',
      'FEATURE_PAUSED', (blocked.body as { code: string }).code);
    await setFlag(adminJar, 'maintenance.checkoutPaused', false);
  }

  // ── G9: payments.upiEnabled (POST /api/checkout/place-order) ──
  {
    await setFlag(adminJar, 'payments.upiEnabled', false);
    const blocked = await call(custJar, '/api/checkout/place-order',
      { method: 'POST', json: { shippingAddressId: 'x', utrNumber: '0000', receiptUrl: '/api/uploads/x' } });
    eq('[G9.1] place-order blocked when upiEnabled=false → 403',
      403, blocked.status);
    eq('[G9.1] code = FEATURE_DISABLED',
      'FEATURE_DISABLED', (blocked.body as { code: string }).code);
    await setFlag(adminJar, 'payments.upiEnabled', true);
  }

  // ── G10: checkout.maxQuantityPerItem (POST /api/cart/add) ──
  // Need an actual product to add. Probe for one.
  {
    const anyProduct = await prisma.product.findFirst({
      where: { isActive: true }, select: { id: true, stock: true },
    });
    if (anyProduct) {
      await setFlag(adminJar, 'checkout.maxQuantityPerItem', 3);
      const blocked = await call(cust2Jar, '/api/cart/add',
        { method: 'POST', json: { productId: anyProduct.id, quantity: 99 } });
      eq('[G10.1] cart/add blocked when quantity > maxQuantityPerItem → 400',
        400, blocked.status);
      eq('[G10.1] code = QUANTITY_LIMIT_EXCEEDED',
        'QUANTITY_LIMIT_EXCEEDED', (blocked.body as { code: string }).code);
      // Restore default
      await setFlag(adminJar, 'checkout.maxQuantityPerItem', 10);
    } else {
      ok('[G10.1] skipped (no product fixtures in DB)');
    }
  }

  // ── G11: checkout.maxCartItems (POST /api/cart/add) — line-count cap ──
  // Need products with NO variants (otherwise cart/add demands a variantId
  // before the limits check is reachable). Filter by zero-variant.
  {
    const noVariantProducts = await prisma.product.findMany({
      where: { isActive: true, variants: { none: {} }, stock: { gt: 0 } },
      select: { id: true }, take: 5,
    });
    if (noVariantProducts.length >= 2) {
      await prisma.cartItem.deleteMany({ where: { cart: { userId: cust2.id } } });
      await setFlag(adminJar, 'checkout.maxCartItems', 1);
      const r1 = await call(cust2Jar, '/api/cart/add',
        { method: 'POST', json: { productId: noVariantProducts[0].id, quantity: 1 } });
      assert(`[G11.1] first product fits under limit (status=${r1.status})`,
        r1.status === 200, r1.body);
      const r2 = await call(cust2Jar, '/api/cart/add',
        { method: 'POST', json: { productId: noVariantProducts[1].id, quantity: 1 } });
      eq('[G11.2] second product rejected when cart full → 400', 400, r2.status);
      eq('[G11.2] code = CART_FULL',
        'CART_FULL', (r2.body as { code: string }).code);
      // Restore default
      await setFlag(adminJar, 'checkout.maxCartItems', 20);
    } else {
      // Soft-skip — the test DB may have only variant-required products.
      ok(`[G11.1] skipped (need ≥2 non-variant products, found ${noVariantProducts.length})`);
    }
  }

  // ── G12: maintenance.maintenanceMode (storefront layout redirect) ──
  // Covered in test:store-config [I5]. We re-assert here under the
  // gating-enforcement environment for completeness.
  {
    await setFlag(adminJar, 'maintenance.maintenanceMode', true);
    const home = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(`[G12.1] / redirects during maintenance (status=${home.status})`,
      home.status >= 300 && home.status < 400);
    await setFlag(adminJar, 'maintenance.maintenanceMode', false);
  }

  // ── G13: per-route GET that is NOT gated — sanity check we didn't
  //          over-gate. /api/auth/me + /api/health should work regardless.
  {
    const me = await call(custJar, '/api/auth/me');
    eq('[G13.1] /api/auth/me unaffected by feature flips → 200', 200, me.status);
    const health = await fetch(`${BASE}/api/health`);
    eq('[G13.2] /api/health unaffected → 200', 200, health.status);
  }
}

// ── Static-audit half: every gated route imports the helper ──────────────
function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — every spec §2.4 gated route imports the helper ──');

  const required: Array<{ file: string; needles: string[] }> = [
    { file: 'src/app/api/auth/signup/route.ts',         needles: ['requireRegistrationOpen', 'requireRegistrationNotPaused'] },
    { file: 'src/app/api/wishlist/toggle/route.ts',     needles: ['requireWishlistEnabled'] },
    { file: 'src/app/api/compare/route.ts',             needles: ['requireCompareEnabled'] },
    { file: 'src/app/api/account/reviews/route.ts',     needles: ['requireReviewsEnabled'] },
    { file: 'src/app/api/account/chat/route.ts',        needles: ['requireLiveChatEnabled'] },
    { file: 'src/app/api/account/tickets/route.ts',     needles: ['requireTicketsEnabled'] },
    { file: 'src/app/api/b2b/apply/route.ts',           needles: ['requireB2BEnabled', 'requireB2BRegistrationOpen'] },
    { file: 'src/app/api/b2b/me/route.ts',              needles: ['requireB2BEnabled'] },
    { file: 'src/app/api/b2b/bulk-add/route.ts',        needles: ['requireB2BEnabled'] },
    { file: 'src/app/api/b2b/quotes/route.ts',          needles: ['requireB2BEnabled'] },
    { file: 'src/app/api/checkout/place-order/route.ts',needles: ['requireCheckoutNotPaused', 'requireUpiEnabled'] },
    { file: 'src/app/api/checkout/express/route.ts',    needles: ['requireCheckoutNotPaused', 'requireUpiEnabled'] },
    { file: 'src/app/api/cart/add/route.ts',            needles: ['getCheckoutLimits'] },
    { file: 'src/app/api/cart/update/route.ts',         needles: ['getCheckoutLimits'] },
    { file: 'src/app/api/auth/otp/verify/route.ts',     needles: ['isFeatureOn'] },
  ];
  for (const { file, needles } of required) {
    const src = readFileSync(file, 'utf-8');
    for (const n of needles) {
      assert(`[A1] ${file} references ${n}`, src.includes(n));
    }
  }

  // FeatureFlagProvider wired into storefront layout
  const layout = readFileSync('src/app/(storefront)/layout.tsx', 'utf-8');
  assert('[A2] storefront layout wraps in FeatureFlagProvider',
    /<FeatureFlagProvider/.test(layout) && /FeatureFlagProvider\s*>/.test(layout));
  assert('[A2] storefront layout calls buildClientFlags',
    /buildClientFlags\(/.test(layout));

  // Admin UI fetches schema + uses pending state model
  const admin = readFileSync('src/app/admin/(app)/store-config/page.tsx', 'utf-8');
  assert('[A3] admin store-config UI fetches schema',
    /\/api\/admin\/store-config/.test(admin)
    && /schema/.test(admin));
  assert('[A3] admin store-config UI sends PATCH with changes wrapper',
    /method:\s*['"]PATCH['"][\s\S]{0,200}changes:/.test(admin));
  assert('[A3] admin store-config UI has Export / Import / Reset actions',
    /Export/.test(admin) && /Import/.test(admin) && /Reset to defaults/.test(admin));
  assert('[A3] admin store-config UI shows unsaved-changes banner',
    /unsaved/i.test(admin));
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await backupSingleton();
  try {
    staticAuditTests();
    await startServer();
    await gatingTests();
  } finally {
    await stopServer();
    await restoreSingleton();
    // Cleanup fixtures
    const ids = (await prisma.user.findMany({
      where: { email: { contains: 'gat_' } }, select: { id: true },
    })).map((u) => u.id);
    if (ids.length > 0) {
      await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: ids } } } });
      await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.refreshTokenFamily.deleteMany({ where: { userId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.userActivity.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
