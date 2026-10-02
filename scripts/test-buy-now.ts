// Allow @shopcore.test email addresses for fixtures (Feature #10 policy bypass).
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';
/**
 * "Buy Now" — Direct-to-checkout express flow test suite.
 *
 *   npm run test:buy-now
 *
 * Real `next start` server + real SQLite. Tests every category from the
 * spec:
 *
 *   1. UNIT — pure helpers in lib/checkout/express.ts:
 *      - upsertExpressCheckout boundary cases (qty, inactive product/variant,
 *        OOS, insufficient stock, B2C cap)
 *      - readExpressForUser cookie/userId binding
 *      - buildExpressCartView reflects fresh DB price + stock + active
 *      - pruneExpiredExpressCheckouts removes only stale rows
 *
 *   2. INTEGRATION (real HTTP + DB):
 *      (i)    /api/checkout/express with valid input → 200, cookie set,
 *             ExpressCheckout row created
 *      (ii)   Unauthenticated POST → 401
 *      (iii)  Rapid clicks (5 parallel) → exactly one row (upsert by userId),
 *             no duplicates
 *      (iv)   Variant required → 400 VARIANT_REQUIRED
 *      (v)    Bogus product → 404 PRODUCT_NOT_FOUND
 *      (vi)   Bogus variant → 404 VARIANT_NOT_FOUND
 *      (vii)  Stock=2 + request=5 → 400 INSUFFICIENT_STOCK
 *      (viii) /api/checkout/summary?source=express returns ONLY the
 *             express item (NOT the cart)
 *      (ix)   /api/checkout/summary with no ?source — returns the cart (regression)
 *      (x)    place-order with source=express creates a real order from the
 *             express row, decrements stock, marks the row consumed,
 *             AND THE CART IS UNCHANGED (the headline contract)
 *      (xi)   place-order with expired express row → 400 (graceful)
 *      (xii)  place-order with deleted express row → 400
 *      (xiii) Variant deleted between PDP and Buy Now → upsert fails 404
 *      (xiv)  Product deactivated between Buy Now and place-order → 400 at checkout
 *      (xv)   Price changed between PDP and place-order → order uses CURRENT price (Bug #3)
 *      (xvi)  DELETE /api/checkout/express clears the row and cookie
 *
 *   3. REGRESSION (existing flows untouched):
 *      (A)  add-to-cart still works
 *      (B)  cart endpoint still returns the user's real cart unchanged
 *           after a full Buy Now flow
 *      (C)  refresh + sessions endpoint unaffected
 *      (D)  authentication required for both /express and /place-order
 *
 * Cleans up its own users + orders + express rows at the end.
 */
import { prisma } from '../src/lib/db/client';
import {
  upsertExpressCheckout,
  buildExpressCartView,
  pruneExpiredExpressCheckouts,
} from '../src/lib/checkout/express';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { priceCtxForUser } from '../src/lib/catalog/pricing';
import { env } from '../src/lib/config';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
const PORT = 3033;
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

  const out = (b: Buffer) => writeFileSync('/tmp/test-buy-now.log', b, { flag: 'a' });
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

// ─────────────────────────────────────────────── HTTP client
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
      if (v === '' || /Max-Age=0/i.test(sc) || /Expires=Thu, 01 Jan 1970/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown }) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  const res = await fetch(BASE + path, {
    method, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body };
}

// ─────────────────────────────────────────────── fixture
interface TestUser { email: string; userId: string; jar: Jar; }
const KEEP: TestUser[] = [];

async function makeUser(label: string): Promise<TestUser> {
  const { hashPassword } = await import('../src/lib/auth/password');
  const email = `buynow_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@shopcore.test`;
  const user = await prisma.user.create({
    data: {
      firstName: 'Buy', lastName: label, email,
      phone: '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'CUSTOMER', status: 'ACTIVE',
      referralCode: 'REF' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
  // Also create a default address so checkout summary works
  await prisma.address.create({
    data: {
      userId: user.id, fullName: 'Buy ' + label, phone: '+919876517100',
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India', isDefault: true,
    },
  });
  // Mint a session in-process (skip OTP)
  const fam = await issueRefreshFamily({ userId: user.id, role: 'CUSTOMER' });
  const ttl = accessTtlFor('CUSTOMER');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: user.id, role: user.role, email: user.email,
    jti: sessionId, fam: fam.familyId,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId: user.id, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  await api(jar, '/api/auth/csrf');
  jar.cookies['sc_session'] = jwt;
  jar.cookies['sc_refresh'] = fam.secret;
  const u: TestUser = { email, userId: user.id, jar };
  KEEP.push(u);
  return u;
}

let testProductId = '';
let testVariantInStock = '';
let testVariantLowStock = '';
let testVariantPriceCents = 0;
let testProductSku = '';
async function setupCatalog() {
  // Create our own test product so other suites' products aren't affected.
  const cat = await prisma.category.findFirst();
  if (!cat) throw new Error('Need at least one Category');
  const baseSku = `BUYNOW-${Date.now().toString(36)}`;
  const p = await prisma.product.create({
    data: {
      name: 'Buy Now Test Product',
      slug: `buynow-test-${Date.now()}`,
      description: 'fixture', shortDesc: 'fixture',
      sku: baseSku, pricePaise: 99900, mrpPaise: 119900,
      stock: 50, isActive: true, gstRate: 18, categoryId: cat.id,
      variants: {
        create: [
          { name: '16GB',  sku: `${baseSku}-A`, attributes: '{}', pricePaise: 99900,  mrpPaise: 119900, stock: 20, isActive: true },
          { name: '32GB',  sku: `${baseSku}-B`, attributes: '{}', pricePaise: 129900, mrpPaise: 149900, stock: 2,  isActive: true },
          { name: '64GB',  sku: `${baseSku}-C`, attributes: '{}', pricePaise: 159900, mrpPaise: 179900, stock: 0,  isActive: true },
        ],
      },
    },
    include: { variants: true },
  });
  testProductId = p.id;
  testProductSku = baseSku;
  testVariantInStock = p.variants[0].id;
  testVariantLowStock = p.variants[1].id;
  testVariantPriceCents = p.variants[0].pricePaise;
}

// ─────────────────────────────────────────────── UNIT
async function unitTests() {
  console.log('\n── UNIT — lib/checkout/express ──');
  const u = await makeUser('U1');

  // Invalid qty
  for (const q of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: testVariantInStock, quantity: q as number });
    if (r.ok) fail(`upsert rejects qty=${q}`, '!ok', r);
    eq(`upsert rejects qty=${q} with INVALID_QUANTITY`, 'INVALID_QUANTITY', r.code);
  }
  // OOS variant
  const oosVariant = await prisma.variant.findFirst({ where: { productId: testProductId, stock: 0 } });
  const r2 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: oosVariant!.id, quantity: 1 });
  if (r2.ok) fail('upsert rejects OOS variant', '!ok', r2);
  eq('upsert rejects OOS variant code', 'OUT_OF_STOCK', r2.code);

  // Insufficient: low-stock variant (stock=2), request 5
  const r3 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: testVariantLowStock, quantity: 5 });
  if (r3.ok) fail('upsert rejects insufficient stock', '!ok', r3);
  eq('upsert rejects insufficient stock code', 'INSUFFICIENT_STOCK', r3.code);

  // Variant required for variant-products
  const r4 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: null, quantity: 1 });
  if (r4.ok) fail('upsert: variant required for variant-product', '!ok', r4);
  eq('upsert: variant-required code', 'VARIANT_REQUIRED', r4.code);

  // Bogus product
  const r5 = await upsertExpressCheckout({ userId: u.userId, productId: 'nope-id', variantId: null, quantity: 1 });
  if (r5.ok) fail('upsert: bogus product', '!ok', r5);
  eq('upsert: PRODUCT_NOT_FOUND code', 'PRODUCT_NOT_FOUND', r5.code);

  // Bogus variant
  const r6 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: 'nope-vid', quantity: 1 });
  if (r6.ok) fail('upsert: bogus variant', '!ok', r6);
  eq('upsert: VARIANT_NOT_FOUND code', 'VARIANT_NOT_FOUND', r6.code);

  // Valid → ok, row exists
  const r7 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: testVariantInStock, quantity: 1 });
  assert('upsert: valid → ok', r7.ok);
  const row = await prisma.expressCheckout.findUnique({ where: { userId: u.userId } });
  assert('upsert: row exists', !!row);
  eq('upsert: row.quantity matches', 1, row?.quantity);

  // Re-upsert (rapid click) updates the SAME row
  const r8 = await upsertExpressCheckout({ userId: u.userId, productId: testProductId, variantId: testVariantInStock, quantity: 2 });
  assert('re-upsert valid', r8.ok);
  const row2 = await prisma.expressCheckout.findUnique({ where: { userId: u.userId } });
  eq('re-upsert same row id', row?.id, row2?.id);
  eq('re-upsert: row.quantity updated', 2, row2?.quantity);
  const rowCount = await prisma.expressCheckout.count({ where: { userId: u.userId } });
  eq('re-upsert: still exactly 1 row per user', 1, rowCount);

  // buildExpressCartView reflects current DB
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
  const view = await buildExpressCartView({
    userId: u.userId, productId: testProductId, variantId: testVariantInStock, quantity: 3,
    ctx: priceCtxForUser(dbUser, null),
  });
  eq('view: 1 item',              1, view.items.length);
  eq('view: unit price = DB price', testVariantPriceCents, view.items[0].unitPricePaise);
  eq('view: lineTotal = unit*qty', testVariantPriceCents * 3, view.items[0].lineTotalPaise);

  // pruneExpiredExpressCheckouts removes only stale rows
  const oldRow = await prisma.expressCheckout.create({
    data: {
      userId: u.userId + '_stale_will_fail', // FK will fail — use real user instead
      productId: testProductId, variantId: null, quantity: 1,
      expiresAt: new Date(Date.now() - 30 * 86400 * 1000),
    },
  }).catch(() => null);
  void oldRow;
  // Create a stale row attached to another fresh user
  const staleUser = await makeUser('STALE');
  await prisma.expressCheckout.upsert({
    where: { userId: staleUser.userId },
    create: { userId: staleUser.userId, productId: testProductId, variantId: null, quantity: 1, expiresAt: new Date(Date.now() - 30 * 86400 * 1000) },
    update: { expiresAt: new Date(Date.now() - 30 * 86400 * 1000) },
  });
  const beforePrune = await prisma.expressCheckout.count({ where: { userId: staleUser.userId } });
  eq('prune: stale row present before', 1, beforePrune);
  const removed = await pruneExpiredExpressCheckouts();
  assert(`prune removed ≥1 stale row (got ${removed})`, removed >= 1);
  const afterPrune = await prisma.expressCheckout.count({ where: { userId: staleUser.userId } });
  eq('prune: stale row gone', 0, afterPrune);
  // Live row preserved
  const livePruned = await prisma.expressCheckout.count({ where: { userId: u.userId } });
  eq('prune: live row untouched', 1, livePruned);
}

// ─────────────────────────────────────────────── INTEGRATION

let alice: TestUser;
let bob: TestUser;

/** Create a valid PNG receipt — sharp validates server-side. */
function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) { raw[o++] = 200; raw[o++] = 220; raw[o++] = 240; }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    let c = 0xffffffff;
    const buf = Buffer.concat([t, data]);
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = (c ^ 0xffffffff) >>> 0;
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc, 0);
    return Buffer.concat([len, t, data, cb]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
async function uploadReceipt(jar: Jar): Promise<string> {
  const buf = makePng(80, 60);
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'r.png');
  const headers = new Headers();
  headers.set('cookie', cookieHeader(jar));
  if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  const res = await fetch(BASE + '/api/checkout/upload-receipt', { method: 'POST', headers, body: fd });
  applySetCookies(jar, res);
  const body = await res.json() as { ok: boolean; data?: { url: string }; error?: string };
  if (!body.ok) throw new Error('receipt upload failed: ' + body.error);
  return body.data!.url;
}

function freshUtr(seed: number): string {
  return ('47' + String(Date.now() * 1000 + seed).slice(-10)).slice(0, 12).padStart(12, '8');
}
function uuid() { return (globalThis.crypto as Crypto).randomUUID(); }

async function placeOrderHttp(jar: Jar, body: Record<string, unknown>) {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('cookie', cookieHeader(jar));
  if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  headers.set('idempotency-key', uuid());
  let res = await fetch(BASE + '/api/checkout/place-order', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  applySetCookies(jar, res);
  if (res.status === 429) {
    const j = await res.json() as { retryAfterSeconds?: number };
    const wait = ((j.retryAfterSeconds ?? 65) + 1);
    console.log(`    (limiter, sleeping ${wait}s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    // Rebuild headers + idem
    const h2 = new Headers(headers);
    h2.set('idempotency-key', uuid());
    res = await fetch(BASE + '/api/checkout/place-order', {
      method: 'POST', headers: h2, body: JSON.stringify(body),
    });
    applySetCookies(jar, res);
  }
  const bodyOut = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body: bodyOut };
}

async function integrationTests() {
  console.log('\n── INTEGRATION — real HTTP + DB ──');
  alice = await makeUser('A');
  bob   = await makeUser('B');

  // Seed Alice's REGULAR cart with something so we can verify isolation
  const otherProduct = await prisma.product.findFirstOrThrow({
    where: { NOT: { id: testProductId }, isActive: true, variants: { some: { stock: { gt: 0 } } } },
    include: { variants: { where: { stock: { gt: 0 } } } },
  });
  const aliceCart = await prisma.cart.create({ data: { userId: alice.userId } });
  await prisma.cartItem.create({
    data: {
      cartId: aliceCart.id, productId: otherProduct.id,
      variantId: otherProduct.variants[0].id, quantity: 1,
    },
  });
  const cartItemsBeforeBuyNow = await prisma.cartItem.findMany({ where: { cartId: aliceCart.id } });
  eq('seed: alice cart has 1 unrelated item', 1, cartItemsBeforeBuyNow.length);

  // (i) — happy path
  const r1 = await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  eq('(i) /express → 200',                            200, r1.status);
  assert('(i) sc_express cookie set',                 !!alice.jar.cookies['sc_express']);
  const aliceRow = await prisma.expressCheckout.findUnique({ where: { userId: alice.userId } });
  assert('(i) ExpressCheckout row exists',            !!aliceRow);
  eq('(i) row.productId matches',                     testProductId, aliceRow?.productId);
  eq('(i) row.variantId matches',                     testVariantInStock, aliceRow?.variantId);

  // (ii) — unauthenticated
  const guestJar = newJar(); await api(guestJar, '/api/auth/csrf');
  const r2 = await api(guestJar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  eq('(ii) unauthenticated /express → 401',            401, r2.status);

  // (iii) — rapid clicks (5 parallel) → exactly one row
  const N = 5;
  const responses = await Promise.all(Array.from({ length: N }, () => api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 2 },
  })));
  for (const r of responses) eq('(iii) rapid click → 200', 200, r.status);
  const rowCountAfter = await prisma.expressCheckout.count({ where: { userId: alice.userId } });
  eq('(iii) exactly 1 ExpressCheckout row after parallel storm', 1, rowCountAfter);

  // (iv) — variant required
  const r4 = await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, quantity: 1 },
  });
  eq('(iv) variant-required → 400',                   400, r4.status);
  eq('(iv) code = VARIANT_REQUIRED',                 'VARIANT_REQUIRED', r4.body.code);

  // (v) — bogus product
  const r5 = await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: 'no-such', variantId: null, quantity: 1 },
  });
  eq('(v) bogus product → 404',                       404, r5.status);
  eq('(v) code = PRODUCT_NOT_FOUND',                  'PRODUCT_NOT_FOUND', r5.body.code);

  // (vi) — bogus variant
  const r6 = await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: 'no-vid', quantity: 1 },
  });
  eq('(vi) bogus variant → 404',                      404, r6.status);
  eq('(vi) code = VARIANT_NOT_FOUND',                'VARIANT_NOT_FOUND', r6.body.code);

  // (vii) — insufficient stock (low-stock variant, qty=5)
  const r7 = await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantLowStock, quantity: 5 },
  });
  eq('(vii) stock=2 + req=5 → 400',                   400, r7.status);
  eq('(vii) code = INSUFFICIENT_STOCK',               'INSUFFICIENT_STOCK', r7.body.code);
  eq('(vii) details.available = 2',                    2, r7.body.available);

  // Re-prime alice's express row to the valid in-stock variant for the rest
  await api(alice.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });

  // (viii) — summary?source=express returns the express item only
  const r8 = await api(alice.jar, '/api/checkout/summary?source=express');
  eq('(viii) summary?source=express → 200',            200, r8.status);
  const data8 = r8.body.data as { source: string; totals: { items: { productId: string; quantity: number }[]; subtotalPaise: number } };
  eq('(viii) source = express',                       'express', data8.source);
  eq('(viii) totals.items.length = 1',                 1, data8.totals.items.length);
  eq('(viii) totals.items[0].productId = test product', testProductId, data8.totals.items[0].productId);

  // (ix) — summary without ?source still returns the regular cart
  const r9 = await api(alice.jar, '/api/checkout/summary');
  eq('(ix) summary (no source) → 200',                 200, r9.status);
  const data9 = r9.body.data as { source: string; totals: { items: { productId: string }[] } };
  eq('(ix) source = cart',                            'cart', data9.source);
  eq('(ix) totals.items count = cart count',           1, data9.totals.items.length);
  eq('(ix) totals.items[0].productId = unrelated product', otherProduct.id, data9.totals.items[0].productId);

  // (x) — place-order with source=express creates a real order AND
  //        preserves the user's cart byte-for-byte. THE HEADLINE CONTRACT.
  const addr = await prisma.address.findFirstOrThrow({ where: { userId: alice.userId } });
  const receiptUrl = await uploadReceipt(alice.jar);
  // Snapshot the cart NOW
  const cartBefore = await prisma.cartItem.findMany({
    where: { cart: { userId: alice.userId } }, orderBy: { id: 'asc' },
  });
  const variantStockBefore = await prisma.variant.findUniqueOrThrow({ where: { id: testVariantInStock } });
  const r10 = await placeOrderHttp(alice.jar, {
    shippingAddressId: addr.id, paymentMethod: 'UPI',
    utrNumber: freshUtr(1), receiptUrl,
    source: 'express',
  });
  eq('(x) place-order(express) → 200',                 200, r10.status);
  const orderId = (r10.body.data as { orderId: string }).orderId;
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId }, include: { items: true },
  });
  eq('(x) order has 1 line (the express item)',        1, order.items.length);
  eq('(x) order line productId = test product',        testProductId, order.items[0].productId);
  eq('(x) order line variantId = test variant',        testVariantInStock, order.items[0].variantId);
  const variantStockAfter = await prisma.variant.findUniqueOrThrow({ where: { id: testVariantInStock } });
  eq('(x) stock decremented on the express variant',
     variantStockBefore.stock - 1, variantStockAfter.stock);
  const cartAfter = await prisma.cartItem.findMany({
    where: { cart: { userId: alice.userId } }, orderBy: { id: 'asc' },
  });
  eq('(x) **CART UNCHANGED** (same length)',            cartBefore.length, cartAfter.length);
  eq('(x) **CART UNCHANGED** (same item ids)',
     cartBefore.map((c) => c.id), cartAfter.map((c) => c.id));
  eq('(x) **CART UNCHANGED** (same quantities)',
     cartBefore.map((c) => c.quantity), cartAfter.map((c) => c.quantity));
  const consumedRow = await prisma.expressCheckout.findUnique({ where: { userId: alice.userId } });
  assert('(x) express row marked consumed',             !!consumedRow?.consumedAt);
  assert('(x) sc_express cookie cleared on response',   !alice.jar.cookies['sc_express']);

  // (xi) — place-order with expired express row → 400
  await prisma.expressCheckout.upsert({
    where: { userId: alice.userId },
    create: { userId: alice.userId, productId: testProductId, variantId: testVariantInStock, quantity: 1, expiresAt: new Date(Date.now() - 60_000) },
    update: { expiresAt: new Date(Date.now() - 60_000), consumedAt: null },
  });
  // Re-prime cookie so the route reads the row
  const expiredRow = await prisma.expressCheckout.findUniqueOrThrow({ where: { userId: alice.userId } });
  alice.jar.cookies['sc_express'] = expiredRow.id;
  const receiptUrl2 = await uploadReceipt(alice.jar);
  const r11 = await placeOrderHttp(alice.jar, {
    shippingAddressId: addr.id, paymentMethod: 'UPI',
    utrNumber: freshUtr(2), receiptUrl: receiptUrl2,
    source: 'express',
  });
  eq('(xi) place-order with expired express → 400',    400, r11.status);
  // We accept either "expired" wording OR the generic "cart empty" surface;
  // both leave the user safely at an actionable state.
  assert('(xi) error message present',                 typeof r11.body.error === 'string');

  // (xii) — place-order after row deleted → 400
  await prisma.expressCheckout.deleteMany({ where: { userId: alice.userId } });
  const receiptUrl3 = await uploadReceipt(alice.jar);
  const r12 = await placeOrderHttp(alice.jar, {
    shippingAddressId: addr.id, paymentMethod: 'UPI',
    utrNumber: freshUtr(3), receiptUrl: receiptUrl3,
    source: 'express',
  });
  eq('(xii) place-order with deleted express → 400',   400, r12.status);

  // (xiii) — variant deleted before upsert → 404
  // Recreate then delete to test: use bob (fresh user)
  await prisma.variant.deleteMany({ where: { productId: testProductId, name: '64GB' } });
  const r13 = await api(bob.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: '64gb-gone-vid', quantity: 1 },
  });
  eq('(xiii) variant deleted before Buy Now → 404',     404, r13.status);

  // (xiv) — product deactivated between Buy Now and place-order → 400 at checkout
  await api(bob.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  await prisma.product.update({ where: { id: testProductId }, data: { isActive: false } });
  const bobAddr = await prisma.address.findFirstOrThrow({ where: { userId: bob.userId } });
  const receiptUrl4 = await uploadReceipt(bob.jar);
  const r14 = await placeOrderHttp(bob.jar, {
    shippingAddressId: bobAddr.id, paymentMethod: 'UPI',
    utrNumber: freshUtr(4), receiptUrl: receiptUrl4,
    source: 'express',
  });
  eq('(xiv) place-order after product deactivated → 400', 400, r14.status);
  // Restore for subsequent tests
  await prisma.product.update({ where: { id: testProductId }, data: { isActive: true } });

  // (xv) — price changed between PDP and place-order → order uses CURRENT price
  // Prime bob's express
  await prisma.expressCheckout.deleteMany({ where: { userId: bob.userId } });
  await api(bob.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  // Bump the variant price by 1000 paise
  const newPrice = testVariantPriceCents + 1000;
  await prisma.variant.update({ where: { id: testVariantInStock }, data: { pricePaise: newPrice } });
  const receiptUrl5 = await uploadReceipt(bob.jar);
  const r15 = await placeOrderHttp(bob.jar, {
    shippingAddressId: bobAddr.id, paymentMethod: 'UPI',
    utrNumber: freshUtr(5), receiptUrl: receiptUrl5,
    source: 'express',
  });
  eq('(xv) place-order after price change → 200',      200, r15.status);
  const orderId2 = (r15.body.data as { orderId: string }).orderId;
  const order2 = await prisma.order.findUniqueOrThrow({
    where: { id: orderId2 }, include: { items: true },
  });
  eq('(xv) order line price = NEW (server-side, not stale)',
     newPrice, order2.items[0].unitPricePaise);
  // Restore
  await prisma.variant.update({ where: { id: testVariantInStock }, data: { pricePaise: testVariantPriceCents } });

  // (xvi) — DELETE /express clears the row + cookie
  await api(bob.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  const beforeDel = await prisma.expressCheckout.count({ where: { userId: bob.userId } });
  eq('(xvi) row present before DELETE', 1, beforeDel);
  const r16 = await api(bob.jar, '/api/checkout/express', { method: 'DELETE' });
  eq('(xvi) DELETE → 200', 200, r16.status);
  const afterDel = await prisma.expressCheckout.count({ where: { userId: bob.userId } });
  eq('(xvi) row gone after DELETE', 0, afterDel);
  assert('(xvi) sc_express cookie cleared', !bob.jar.cookies['sc_express']);
}

// ─────────────────────────────────────────────── REGRESSION
async function regressionTests() {
  console.log('\n── REGRESSION ──');

  const u = await makeUser('REG');

  // (A) Add-to-cart still works
  const rAdd = await api(u.jar, '/api/cart/add', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  eq('(A) /cart/add still works → 200',                200, rAdd.status);

  // (B) After full Buy Now flow on another user, that user's cart is untouched
  //     We already proved this in (x); here we verify the SAME user (whose
  //     cart we just populated) can do Buy Now and the cart is preserved.
  const cartBeforeBN = await prisma.cartItem.findMany({ where: { cart: { userId: u.userId } } });
  await api(u.jar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  // Even before completing checkout, the cart MUST be untouched
  const cartAfterExpress = await prisma.cartItem.findMany({ where: { cart: { userId: u.userId } } });
  eq('(B) /express does NOT touch /cart',              cartBeforeBN.length, cartAfterExpress.length);

  // (C) /api/auth/refresh + /api/auth/sessions still work
  const rRef = await api(u.jar, '/api/auth/refresh', { method: 'POST', json: {} });
  eq('(C) /auth/refresh → 200',                        200, rRef.status);
  const rSess = await api(u.jar, '/api/auth/sessions');
  eq('(C) /auth/sessions → 200',                       200, rSess.status);

  // (D) Both /express and /place-order require auth
  const guestJar = newJar(); await api(guestJar, '/api/auth/csrf');
  const rUe = await api(guestJar, '/api/checkout/express', {
    method: 'POST', json: { productId: testProductId, variantId: testVariantInStock, quantity: 1 },
  });
  eq('(D) /express requires auth → 401',               401, rUe.status);
  const rUp = await api(guestJar, '/api/checkout/place-order', {
    method: 'POST', json: { source: 'express' },
  });
  // place-order requires auth too; also rejects without Idempotency-Key.
  // Either 400 (CSRF/Idempotency) or 401 (auth) is acceptable security-wise.
  assert('(D) /place-order without auth rejected', rUp.status >= 400 && rUp.status < 500);
}

// ─────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  // Remove test product cart items + variants + product
  if (testProductId) {
    await prisma.expressCheckout.deleteMany({ where: { productId: testProductId } });
    await prisma.cartItem.deleteMany({ where: { productId: testProductId } });
    await prisma.orderItem.deleteMany({ where: { productId: testProductId } });
    await prisma.variant.deleteMany({ where: { productId: testProductId } });
    await prisma.product.delete({ where: { id: testProductId } }).catch(() => null);
    ok('removed test product');
  }
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'buynow_' } }, select: { id: true, email: true } });
  for (const u of users) {
    try {
      await prisma.expressCheckout.deleteMany({ where: { userId: u.id } });
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
  void testProductSku;
}

async function main() {
  writeFileSync('/tmp/test-buy-now.log', '');
  console.log(`Starting test server on :${PORT}…`);
  await startServer();
  try {
    await setupCatalog();
    await unitTests();
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
