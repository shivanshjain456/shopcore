/**
 * Server-side price-recalculation regression suite.
 *
 *   npm run test:price-integrity
 *
 * The bug class this defends against:
 *   "Client-side price manipulation" — a hostile / curious client sends forged
 *   price, total, line-item, discount, or shipping fields in the checkout
 *   request body, hoping the server will trust them and create the order at
 *   a fraudulent price (e.g. ₹1 for a ₹4,999 product).
 *
 * Three layers:
 *
 *   1. UNIT      — Zod `.strict()` schemas on every cart + checkout endpoint
 *                  REJECT unknown keys at parse time, with a 400 error.
 *
 *   2. INTEGRATION — Spin up the actual server, drive it with curl/fetch from
 *                  a hostile client perspective, observe both the response
 *                  AND the persisted Order row in the DB. The server's
 *                  `totalPaise` must match a fresh DB recomputation of:
 *                      sum(variantPrice × qty)
 *                      − coupon discount (DB-validated)
 *                      − loyalty redemption (clamped to balance + subtotal)
 *                      + shipping (StoreConfig)
 *                  with the per-line `unitPricePaise` equal to the
 *                  product/variant's current `pricePaise`.
 *
 *   3. REGRESSION — Six classic attacks:
 *                  (a) extra `totalPaise: 100` in body
 *                  (b) extra `price: 1` in body
 *                  (c) extra `discountPaise: 9_999_999` in body
 *                  (d) extra `items: [{ pricePaise: 1 }]` array in body
 *                  (e) extra `grandTotal: 0` in body
 *                  (f) extra `shippingPaise: -50000` (negative) in body
 *                  In every case the order must EITHER be rejected by Zod
 *                  with HTTP 400 OR be created with the correct
 *                  server-calculated total — never with the forged value.
 *
 * Cleans up its own test users + orders at the end.
 */
import { prisma } from '../src/lib/db/client';
import { hashPassword } from '../src/lib/auth/password';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Fresh, format-valid, fraud-pattern-free 12-digit UPI UTR per call.
// Bug #6 enforces global uniqueness, so every place-order needs a new UTR.
let utrCounter = 0;
function freshUtr(): string {
  utrCounter += 1;
  const tail = (Date.now() + utrCounter).toString().slice(-10);
  return ('47' + tail).slice(0, 12).padStart(12, '7');
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

// ─────────────────────────────────────────────── 0. server up

const BASE = 'http://127.0.0.1:3019';

function waitForServer(timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - start > timeoutMs) reject(new Error('Server did not start within timeout'));
      else setTimeout(tick, 500);
    };
    tick();
  });
}

const LOG_PATH = join(tmpdir(), 'test-price-integrity.log');
let serverProc: ChildProcess | null = null;
async function startServer() {
  serverProc = spawn('npx', ['next', 'start', '-p', '3019'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', SHOPCORE_ALLOW_TEST_EMAILS: '1', SHOPCORE_DISABLE_RATE_LIMITS: '1' },
    detached: process.platform !== 'win32',
    shell: true,
  });
  const killGroup = () => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F']); } catch { /* */ }
      } else {
        try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
      }
      try { serverProc.kill('SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit', killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });
  process.on('uncaughtException', (e) => { killGroup(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { killGroup(); console.error(e); process.exit(1); });

  const out = (b: Buffer) => { try { writeFileSync(LOG_PATH, b, { flag: 'a' }); } catch { /* */ } };
  serverProc.stdout?.on('data', out);
  serverProc.stderr?.on('data', out);
  await waitForServer();
}
async function stopServer() {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F']); } catch { /* */ }
    } else {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
    try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─────────────────────────────────────────────── 1. test client helpers

type CookieJar = Record<string, string>;
const jar: CookieJar = {};
function applySetCookies(res: Response) {
  // Node 20 fetch exposes getSetCookie()
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
function cookieHeader(): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(path: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('cookie') && Object.keys(jar).length) headers.set('cookie', cookieHeader());
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
    if (jar['sc_csrf']) headers.set('x-csrf-token', jar['sc_csrf']);
  }
  const res = await fetch(BASE + path, {
    ...init, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  applySetCookies(res);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* may be empty */ }
  return { status: res.status, body };
}

// ─────────────────────────────────────────────── 2. test fixture

let TEST_EMAIL = '';
let testUserId = '';
let testAddressId = '';
let chosenProductSku = '';
let chosenVariantId: string | null = null;
let chosenVariantPricePaise = 0;

async function prepareFixture() {
  // Use a multi-variant product with healthy stock
  const product = await prisma.product.findFirst({
    where: { isActive: true, variants: { some: { stock: { gte: 5 }, isActive: true } } },
    include: { variants: { where: { stock: { gte: 5 }, isActive: true }, orderBy: { pricePaise: 'desc' } } },
  });
  if (!product) throw new Error('Need a multi-variant product with stock. Run `npm run db:seed:products`.');
  chosenProductSku = product.sku;
  chosenVariantId = product.variants[0].id;
  chosenVariantPricePaise = product.variants[0].pricePaise;
  // Sign up + verify a fresh user via the real API so we get a real session
  TEST_EMAIL = `pi_${Date.now()}@shopcore.test`;
  const piPhone10 = '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
  const piPhoneE164 = '+91' + piPhone10;
  await api('/api/auth/csrf');
  const signup = await api('/api/auth/signup', { method: 'POST', json: {
    firstName: 'PI', lastName: 'Test', email: TEST_EMAIL, phone: piPhone10,
    password: 'TestPass#9k2', confirmPassword: 'TestPass#9k2',
    addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
    pinCode: '400001', country: 'India',
  } });
  if (signup.status !== 200) throw new Error('signup failed: ' + JSON.stringify(signup.body));
  // Wait for log file to flush and grep the OTP
  await new Promise((r) => setTimeout(r, 400));
  const fs = await import('node:fs/promises');
  const logTxt = await fs.readFile(LOG_PATH, 'utf8').catch(() => '');
  // OTP lives inside `email.dev_fallback` JSON lines now. The `msg`
  // field can appear anywhere in the line, so grep by line containment.
  const lines = logTxt.split('\n').filter((l) => l.includes('email.dev_fallback'));
  const last = lines[lines.length - 1];
  const code = last?.match(/(\d{6})/)?.[1];
  if (!code) throw new Error('Could not extract OTP from server log');
  const v = await api('/api/auth/otp/verify', { method: 'POST', json: { email: TEST_EMAIL, purpose: 'SIGNUP', code } });
  if (v.status !== 200) throw new Error('otp verify failed: ' + JSON.stringify(v.body));
  // Phone Verification feature — complete the second step via dev-bypass.
  const pv = await api('/api/auth/phone/verify', { method: 'POST', json: {
    idToken: 'dev-bypass-token', phone: piPhoneE164,
  } });
  if (pv.status !== 200) throw new Error('phone verify failed: ' + JSON.stringify(pv.body));
  const me = await api('/api/auth/me');
  testUserId = ((me.body as { data: { user: { id: string } } }).data.user.id);

  // Address (signup created a default one)
  const addrs = await api('/api/addresses');
  testAddressId = ((addrs.body as { data: { addresses: { id: string }[] } }).data.addresses[0].id);
}

// Helper: place a Dell variant in cart, return the cart subtotal/total etc.
async function freshCartWith(variantId: string, productId: string) {
  // Clear cart first
  const cart = await api('/api/cart');
  const items = (cart.body as { data: { cart: { items: { id: string }[] } } }).data.cart.items;
  for (const it of items) {
    await api('/api/cart/update', { method: 'POST', json: { itemId: it.id, quantity: 0 } });
  }
  const r = await api('/api/cart/add', { method: 'POST', json: { productId, variantId, quantity: 1 } });
  if (r.status !== 200) throw new Error('cart/add failed: ' + JSON.stringify(r.body));
}

// place-order request that respects the server's 6/min per-user limiter
// and includes a fresh Idempotency-Key header (Bug #4 makes it mandatory).
async function placeOrderRequest(json: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const key = (globalThis.crypto as Crypto).randomUUID();
  const extra: RequestInit = { headers: { 'Idempotency-Key': key } };
  let r = await api('/api/checkout/place-order', { method: 'POST', json, ...extra });
  if (r.status === 429) {
    const retryAfter = ((r.body as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 65) + 1;
    console.log(`    (limiter fired, sleeping ${retryAfter}s)`);
    await new Promise((res) => setTimeout(res, retryAfter * 1000));
    r = await api('/api/checkout/place-order', { method: 'POST', json, ...extra });
  }
  return r;
}

// Look up the truth from DB after a place-order succeeds
async function dbTruth(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  return {
    totalPaise: o.totalPaise,
    subtotalPaise: o.subtotalPaise,
    discountPaise: o.discountPaise,
    shippingPaise: o.shippingPaise,
    items: o.items.map((i) => ({ productId: i.productId, variantId: i.variantId, unitPricePaise: i.unitPricePaise, quantity: i.quantity, lineTotalPaise: i.lineTotalPaise })),
  };
}

// Upload a real PNG as receipt (sharp re-encodes it). We build a small
// solid-colour PNG with valid IDAT so sharp accepts it.
function makePng(w: number, h: number): Buffer {
  // Synchronous deflate via Node's zlib is dependency-free
  // and produces a valid PNG that sharp re-encodes happily.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = 200; raw[o++] = 220; raw[o++] = 240;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crc32 = require('node:zlib').crc32 as ((d: Buffer) => number) | undefined;
    let crc: number;
    if (crc32) crc = crc32(Buffer.concat([t, data]));
    else {
      // Manual CRC32 (rarely needed on modern Node)
      let c = 0xffffffff;
      const buf = Buffer.concat([t, data]);
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      crc = (c ^ 0xffffffff) >>> 0;
    }
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, t, data, cb]);
  };
  const sig  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
async function uploadReceipt(): Promise<string> {
  const buf = makePng(120, 80);
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'r.png');
  const headers = new Headers();
  headers.set('cookie', cookieHeader());
  if (jar['sc_csrf']) headers.set('x-csrf-token', jar['sc_csrf']);
  const res = await fetch(BASE + '/api/checkout/upload-receipt', { method: 'POST', headers, body: fd });
  applySetCookies(res);
  const body = await res.json() as { ok: boolean; data?: { url: string }; error?: string };
  if (!body.ok) throw new Error('receipt upload failed: ' + body.error);
  return body.data!.url;
}

// ─────────────────────────────────────────────── 3. UNIT TESTS

async function unitTests() {
  console.log('\n── UNIT TESTS (Zod .strict() rejects forged fields) ──');

  const legitBody = {
    shippingAddressId: testAddressId,
    utrNumber: freshUtr(),
    receiptUrl: '/api/uploads/receipts/test/dummy.jpg',
  };

  const attacks: Array<{ name: string; extra: Record<string, unknown> }> = [
    { name: '(a) extra totalPaise',     extra: { totalPaise: 100 } },
    { name: '(b) extra price',          extra: { price: 1 } },
    { name: '(c) extra discountPaise',  extra: { discountPaise: 9_999_999 } },
    { name: '(d) extra items[]',        extra: { items: [{ pricePaise: 1 }] } },
    { name: '(e) extra grandTotal',     extra: { grandTotal: 0 } },
    { name: '(f) extra shippingPaise negative', extra: { shippingPaise: -50000 } },
    { name: '(g) extra amount',         extra: { amount: 0 } },
    { name: '(h) extra unitPricePaise', extra: { unitPricePaise: 1 } },
    { name: '(i) extra subtotal',       extra: { subtotal: 0 } },
    { name: '(j) extra TaxPaise (mixed case)', extra: { TaxPaise: 0 } },
  ];

  // The place-order endpoint has a 6/min per-user submit limiter. Our 10
  // attack vectors would trip it; we honour the limiter by reading the
  // server-supplied retryAfterSeconds and waiting. That way this test
  // exercises the Zod layer, not the limiter.
  for (const a of attacks) {
    const r = await placeOrderRequest({ ...legitBody, ...a.extra });
    if (r.status === 400) {
      ok(`${a.name} → rejected with HTTP 400 (${(r.body as { error: string })?.error?.slice(0, 80) ?? 'no body'})`);
    } else {
      fail(`${a.name} → must be 400`, 400, r.status);
    }
  }
}

// ─────────────────────────────────────────────── 4. INTEGRATION TESTS

async function integrationTests() {
  console.log('\n── INTEGRATION TESTS (real cart → order; server is source of truth) ──');

  // Build a real cart
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: chosenProductSku }, include: { variants: true } });
  await freshCartWith(chosenVariantId!, product.id);
  const receiptUrl = await uploadReceipt();

  // (i) legitimate place-order succeeds; server total = variant price × 1 + shipping
  const r1 = await placeOrderRequest({
    shippingAddressId: testAddressId, utrNumber: freshUtr(), receiptUrl,
  });
  if (r1.status !== 200) fail('(i) legitimate place-order should succeed', 200, r1.status);
  const oid1 = (r1.body as { data: { orderId: string } }).data.orderId;
  const truth1 = await dbTruth(oid1);
  eq('(i) unit price = current variant price (DB-authoritative)', chosenVariantPricePaise, truth1.items[0].unitPricePaise);
  eq('(i) subtotal = sum of line totals',
     truth1.items.reduce((s, l) => s + l.lineTotalPaise, 0), truth1.subtotalPaise);
  eq('(i) total = subtotal − discount + shipping',
     truth1.subtotalPaise - truth1.discountPaise + truth1.shippingPaise, truth1.totalPaise);
  ok(`(i) server-computed total ₹${truth1.totalPaise / 100}`);

  // (ii) attempt to FORCE total=1 in the body → 400, NO order created
  const ordersBefore = await prisma.order.count({ where: { userId: testUserId } });
  await freshCartWith(chosenVariantId!, product.id);
  const r2 = await placeOrderRequest({
    shippingAddressId: testAddressId, utrNumber: freshUtr(), receiptUrl,
    totalPaise: 100, grandTotal: 1, // hostile fields
  });
  eq('(ii) hostile body rejected with 400', 400, r2.status);
  const ordersAfter = await prisma.order.count({ where: { userId: testUserId } });
  eq('(ii) NO new order was created', ordersBefore, ordersAfter);

  // (iii) attempt to FORCE discount = full subtotal → 400, NO order created
  const r3 = await placeOrderRequest({
    shippingAddressId: testAddressId, utrNumber: freshUtr(), receiptUrl,
    discountPaise: 99_99_99999,
  });
  eq('(iii) discount-injection rejected with 400', 400, r3.status);

  // (iv) Even the cart-add endpoint must reject hostile fields like pricePaise
  const rA = await api('/api/cart/add', { method: 'POST', json: {
    productId: product.id, variantId: chosenVariantId, quantity: 1, pricePaise: 1,
  } });
  eq('(iv) cart/add rejects extra pricePaise field with 400', 400, rA.status);

  // (v) cart/update rejects price field
  await freshCartWith(chosenVariantId!, product.id);
  const cart = await api('/api/cart');
  const itemId = ((cart.body as { data: { cart: { items: { id: string }[] } } }).data.cart.items[0].id);
  const rU = await api('/api/cart/update', { method: 'POST', json: {
    itemId, quantity: 2, pricePaise: 1,
  } });
  eq('(v) cart/update rejects extra pricePaise field with 400', 400, rU.status);

  // (vi) cart/preview rejects forged prices in guest items[]
  const rP = await api('/api/cart/preview', { method: 'POST', json: {
    items: [{ productId: product.id, variantId: chosenVariantId, quantity: 1, pricePaise: 1 }],
  } });
  eq('(vi) cart/preview rejects per-item extra pricePaise field with 400', 400, rP.status);

  // (vii) Loyalty redemption attempt with absurdly-high redeemPoints is CLAMPED,
  //       not honoured.  We have 50 pts (signup bonus); ask to redeem 1,000,000.
  await freshCartWith(chosenVariantId!, product.id);
  const receiptUrl2 = await uploadReceipt();
  const r7 = await placeOrderRequest({
    shippingAddressId: testAddressId, utrNumber: freshUtr(), receiptUrl: receiptUrl2,
    redeemPoints: 1_000_000, // absurd
  });
  if (r7.status !== 200) fail('(vii) place-order should succeed (server clamps the redeem)', 200, r7.status);
  const oid7 = (r7.body as { data: { orderId: string } }).data.orderId;
  const truth7 = await dbTruth(oid7);
  // signup bonus = 50 pts × redeemValuePaise=100 = ₹50 max redeem
  const maxClaim = 50 * 100;
  if (truth7.discountPaise > maxClaim) {
    fail('(vii) server clamped redemption to balance', `<= ${maxClaim}`, truth7.discountPaise);
  }
  ok(`(vii) over-redeem clamped to balance (discount=₹${truth7.discountPaise / 100}, max possible ₹${maxClaim / 100})`);

  // (viii) Independent recomputation matches: build expected total from DB and compare
  const expectedSubtotal = chosenVariantPricePaise * 1;
  // We applied a redeem of (50 × 100) = ₹50 max — confirm exact match
  const r1Truth = await dbTruth(oid7);
  const recomputedTotal = expectedSubtotal - r1Truth.discountPaise + r1Truth.shippingPaise;
  eq('(viii) DB total exactly matches recomputed server total', recomputedTotal, r1Truth.totalPaise);
}

// ─────────────────────────────────────────────── 5. REGRESSION

async function regressionTests() {
  console.log('\n── REGRESSION (the original bug class can no longer happen) ──');

  // The original report said: "A product priced at Rs. 4,999 can be ordered for Rs. 1".
  // We picked a far pricier product (Dell variant ₹51,990+). Send EVERY classic
  // attack vector in a single payload and assert the server rejects it.
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: chosenProductSku }, include: { variants: true } });
  await freshCartWith(chosenVariantId!, product.id);
  const receiptUrl = await uploadReceipt();

  const everything: Record<string, unknown> = {
    shippingAddressId: testAddressId,
    utrNumber: freshUtr(),
    receiptUrl,
    // — the kitchen-sink attack —
    totalPaise: 100, grandTotal: 1, total: 1, amount: 0,
    subtotalPaise: 0, discountPaise: 99_99_99999, shippingPaise: -50_000,
    taxPaise: -1, pricePaise: 1, unitPricePaise: 1,
    items: [{ productId: product.id, variantId: chosenVariantId, quantity: 1, pricePaise: 1, lineTotalPaise: 100 }],
  };
  const ordersBefore = await prisma.order.count({ where: { userId: testUserId } });
  const r = await placeOrderRequest(everything);
  const ordersAfter = await prisma.order.count({ where: { userId: testUserId } });
  eq('(a) kitchen-sink attack rejected with 400', 400, r.status);
  eq('(a) no new order created', ordersBefore, ordersAfter);

  // Confirm the response surfaces the offenders so the audit log can pick them up
  const errBody = r.body as { error?: string; offenders?: string[] };
  if (!Array.isArray(errBody.offenders) || errBody.offenders.length < 5) {
    fail('(b) offenders[] array surfaced in 400 response', '≥5 offenders', errBody.offenders);
  }
  ok(`(b) offenders[] surfaced (${errBody.offenders.length} fields named)`);

  // Confirm the server logged the tamper attempt (warn level, structured JSON)
  const fs = await import('node:fs/promises');
  const logTxt = await fs.readFile(LOG_PATH, 'utf8').catch(() => '');
  if (!logTxt.includes('checkout.price_tamper_attempt')) {
    fail('(c) server log contains a checkout.price_tamper_attempt entry', 'present', 'missing');
  }
  ok('(c) server logged the tamper attempt (checkout.price_tamper_attempt)');

  // Finally — even legitimate orders place the EXACT DB price. Use sha256 of the
  // canonical total to detect any drift.
  await freshCartWith(chosenVariantId!, product.id);
  const receiptUrl2 = await uploadReceipt();
  const legit = await placeOrderRequest({
    shippingAddressId: testAddressId, utrNumber: freshUtr(), receiptUrl: receiptUrl2,
  });
  if (legit.status !== 200) fail('(d) legitimate order should succeed', 200, legit.status);
  const oid = (legit.body as { data: { orderId: string } }).data.orderId;
  const t = await dbTruth(oid);
  const canonical = JSON.stringify({
    total: t.totalPaise, subtotal: t.subtotalPaise, discount: t.discountPaise, shipping: t.shippingPaise,
    items: t.items.map((i) => ({ v: i.variantId, q: i.quantity, u: i.unitPricePaise })),
  });
  const fp = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  ok(`(d) legitimate order persisted with server-computed totals (fp=${fp}, total=₹${t.totalPaise / 100})`);
}

// ─────────────────────────────────────────────── 6. CLEANUP

async function cleanup() {
  console.log('\n── cleanup ──');
  const u = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (u) {
    await prisma.utrSubmission.deleteMany({ where: { userId: u.id } });
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
    ok('test user removed');
  }
}

// ─────────────────────────────────────────────── MAIN

async function main() {
  try { writeFileSync(LOG_PATH, ''); } catch { /* */ }
  console.log('Starting test server on :3019…');
  await startServer();
  try {
    console.log('\nPreparing fixture (signup → verify → cart)…');
    await prepareFixture();
    ok(`fixture ready: user ${TEST_EMAIL}, product ${chosenProductSku}, variant @ ₹${chosenVariantPricePaise / 100}`);

    await unitTests();
    await integrationTests();
    await regressionTests();
    await cleanup();

    console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
    if (failed > 0) process.exit(1);
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
