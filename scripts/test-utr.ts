/**
 * UTR verification & anti-fraud regression suite — Bug #6.
 *
 *   npm run test:utr
 *
 * Three layers, exactly as the bug-report demanded:
 *
 *   1. UNIT — pure helpers in lib/checkout/utr.ts:
 *      - sanitizeUtr() trims, strips non-alphanumerics, uppercases, handles
 *        null/undefined/non-string
 *      - validateUtrFormat() accepts real NPCI/RBI-formatted UTRs for each
 *        method and rejects shape mismatches across methods
 *      - detectFraudPattern() rejects all-zeros / repeated-digit / TEST /
 *        sequential / short-block-repeat patterns; accepts real-looking ones
 *      - assertUtrAcceptable() composes them with the correct error codes
 *      - maskUtr() reveals exactly the last 4 chars; handles short / null
 *      - isPaymentMethod() type guard
 *
 *   2. INTEGRATION — real HTTP against a spawned `next start`, real DB:
 *      Customer place-order:
 *        (i)    Missing paymentMethod defaults to UPI and a valid 12-digit
 *               UTR places the order
 *        (ii)   Invalid paymentMethod ('CASH') → 400 BAD_METHOD
 *        (iii)  UPI with NEFT-shaped UTR → 400 BAD_FORMAT
 *        (iv)   NEFT with UPI-shaped UTR → 400 BAD_FORMAT
 *        (v)    All zeros (UPI) → 400 FRAUD_PATTERN, NO order created
 *        (vi)   All sixes (UPI) → 400 FRAUD_PATTERN
 *        (vii)  Sequential 123456789012 → 400 FRAUD_PATTERN
 *        (viii) "TEST12345678" (matches TEST keyword) → 400 BAD_FORMAT
 *               (caught by format check before fraud; either is acceptable)
 *        (ix)   Whitespace-only UTR ('   ') → 400 EMPTY
 *        (x)    Sanitised correctly: '  4259-1234-5678  ' → stored as
 *               '425912345678'; order created
 *        (xi)   Lowercase NEFT 'sbin0n12345678901' → stored uppercased
 *        (xii)  UTR-reuse rejected: re-submit a UTR already used by ANOTHER
 *               of THIS user's orders → 409 DUPLICATE
 *        (xiii) Cross-user UTR-reuse rejected: user A uses UTR; user B tries
 *               same UTR on a different order → 409 DUPLICATE (sharing fraud)
 *        (xiv)  Concurrent UTR-reuse race: two parallel place-order POSTs
 *               with the SAME UTR but different idempotency keys & carts →
 *               EXACTLY ONE 200 + EXACTLY ONE 409. DB has only 1 order with
 *               that UTR.
 *
 *      Customer-facing UTR masking:
 *        (xv)   GET /api/orders/[id] returns masked UTR ('********5678')
 *        (xvi)  GET /api/orders returns masked UTRs in the list
 *
 *      Admin verify pipeline:
 *        (xvii) verify-payment with amountMatches=false → 400 (admin must
 *               attest)
 *        (xviii) verify-payment with amountMatches missing → 400
 *        (xix)  verify-payment with amountMatches=true + matching bankReference
 *               → 200 (paymentStatus=VERIFIED, UtrSubmission.status=VERIFIED)
 *        (xx)   verify-payment with amountMatches=true + MISMATCHED
 *               bankReference → 400 (rejection: amount-or-utr mismatch
 *               wording surfaces)
 *
 *      Forensics:
 *        (xxi)  Every rejected UTR (format / fraud / duplicate) writes a
 *               UtrSubmission row with the correct status, raw input, and
 *               clientIp/userAgent — for fraud investigation
 *
 *   3. REGRESSION — the original bug class, each scenario from the report:
 *      (A) Fake UTR ('000000000000') → rejected, order NOT created
 *      (B) Reuse of past UTR → rejected
 *      (C) Cross-account UTR sharing → rejected
 *      (D) Random typing ('XXXX1234XXXX' shapes) → rejected
 *      (E) Sanitisation roundtrip: spaces/dashes stripped, casing normalised
 *
 * Cleans up its own users / orders / UtrSubmissions on success or failure.
 */
import { prisma } from '../src/lib/db/client';
import {
  sanitizeUtr, validateUtrFormat, detectFraudPattern, assertUtrAcceptable,
  maskUtr, isPaymentMethod, PAYMENT_METHODS, type PaymentMethod,
} from '../src/lib/checkout/utr';
import { verifyPayment } from '../src/lib/admin/orders';
import { spawn, type ChildProcess } from 'node:child_process';
// Cross-process OTP capture (the structured logger masks emails in
// server log lines, so we read the OTP from the JSON-lines file the
// server writes when SHOPCORE_TEST_OTP_FILE is set).
import { existsSync as _existsSync, readFileSync as _readFileSync, unlinkSync as _unlinkSync } from 'node:fs';
const OTP_FILE = `/tmp/test-utr-otp-${process.pid}.jsonl`;
try { if (_existsSync(OTP_FILE)) _unlinkSync(OTP_FILE); } catch { /* */ }
interface CapturedOtp { email: string; code: string; purpose: string; ts: number; }
function latestOtpFor(email: string, purpose: string = 'SIGNUP'): string | null {
  if (!_existsSync(OTP_FILE)) return null;
  // Signup schema lowercases email before issuing the OTP, so compare
  // case-insensitively to handle any-case caller input.
  const wanted = email.toLowerCase();
  const lines = _readFileSync(OTP_FILE, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]) as CapturedOtp;
      if (o.email.toLowerCase() === wanted && o.purpose === purpose) return o.code;
    } catch { /* */ }
  }
  return null;
}
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

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

const PORT = 3025;
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

  const out = (b: Buffer) => writeFileSync('/tmp/test-utr.log', b, { flag: 'a' });
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

// ─────────────────────────────────────────────── 1. HTTP client with per-user jars

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response) {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(jar: Jar, path: string, init?: {
  method?: string; json?: unknown; idemKey?: string; headers?: Record<string, string>;
}) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
    if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (init?.idemKey) headers.set('idempotency-key', init.idemKey);
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

// ─────────────────────────────────────────────── 2. fixture helpers

function uuid() { return (globalThis.crypto as Crypto).randomUUID(); }

// A counter-based, fraud-pattern-safe UTR generator. "47" prefix keeps
// it 12 chars / not all-same / not all-zero / not in the sequential block-list.
let utrCounter = 0;
function freshUpiUtr(): string {
  utrCounter += 1;
  const tail = String(Date.now() * 1000 + utrCounter).slice(-10);
  return ('47' + tail).slice(0, 12).padStart(12, '8');
}
function freshNeftUtr(): string {
  utrCounter += 1;
  const tail = String(Date.now() * 1000 + utrCounter).slice(-11);
  return ('SBINN' + tail).slice(0, 16).padEnd(16, '7');
}
function freshRtgsUtr(): string {
  utrCounter += 1;
  const tail = String(Date.now() * 1000 + utrCounter).slice(-12);
  return ('HDFCR' + tail).slice(0, 17).padEnd(17, '7');
}

// Real PNG receipt — sharp validates server-side
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

// ─────────────────────────────────────────────── 3. user signup helper

interface TestUser { email: string; jar: Jar; userId: string; addressId: string; }

async function signupAndVerify(label: string): Promise<TestUser> {
  const jar = newJar();
  const email = `utr_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@shopcore.test`;
  await api(jar, '/api/auth/csrf');
  const phone10 = '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
  const phoneE164 = '+91' + phone10;
  const su = await api(jar, '/api/auth/signup', { method: 'POST', json: {
    firstName: 'Utr', lastName: label, email, phone: phone10,
    password: 'TestPass#9k2', confirmPassword: 'TestPass#9k2',
    addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
    pinCode: '400001', country: 'India',
  } });
  if (su.status !== 200) throw new Error(`signup ${label}: ` + JSON.stringify(su.body));
  await new Promise((r) => setTimeout(r, 400));
  // Primary lookup via SHOPCORE_TEST_OTP_FILE — robust against the
  // structured logger's email masking.
  const code = latestOtpFor(email, 'SIGNUP');
  if (!code) throw new Error(`OTP not found in OTP_FILE for ${email}`);
  const v = await api(jar, '/api/auth/otp/verify', { method: 'POST', json: { email, purpose: 'SIGNUP', code } });
  if (v.status !== 200) throw new Error(`OTP verify ${label}: ` + JSON.stringify(v.body));
  // Phone Verification feature — complete the second step via dev-bypass.
  const pv = await api(jar, '/api/auth/phone/verify', { method: 'POST', json: {
    idToken: 'dev-bypass-token', phone: phoneE164,
  } });
  if (pv.status !== 200) throw new Error(`phone verify ${label}: ` + JSON.stringify(pv.body));
  const me = await api(jar, '/api/auth/me');
  const userId = (me.body.data as { user: { id: string } }).user.id;
  const addrs = await api(jar, '/api/addresses');
  const addressId = (addrs.body.data as { addresses: { id: string }[] }).addresses[0].id;
  return { email, jar, userId, addressId };
}

// ─────────────────────────────────────────────── 4. cart + place-order helpers

let chosenProductId = '';
let chosenVariantId: string | null = null;

async function pickProduct() {
  // Need a product with stock so we can place real orders
  const product = await prisma.product.findFirst({
    where: { isActive: true, variants: { some: { stock: { gte: 5 }, isActive: true } } },
    include: { variants: { where: { stock: { gte: 5 }, isActive: true } } },
  });
  if (!product) throw new Error('Need a variant-product with ≥5 stock');
  chosenProductId = product.id;
  chosenVariantId = product.variants[0].id;
}

async function freshCart(u: TestUser) {
  const cart = await api(u.jar, '/api/cart');
  const items = ((cart.body.data as { cart: { items: { id: string }[] } } | undefined)?.cart.items) ?? [];
  for (const it of items) {
    await api(u.jar, '/api/cart/update', { method: 'POST', json: { itemId: it.id, quantity: 0 } });
  }
  await api(u.jar, '/api/cart/add', { method: 'POST', json: { productId: chosenProductId, variantId: chosenVariantId, quantity: 1 } });
}

async function placeOrderHttp(u: TestUser, body: Record<string, unknown>) {
  const json = { idempotencyKey: uuid(), ...body };
  const idemKey = String(json.idempotencyKey);
  delete (json as Record<string, unknown>).idempotencyKey;
  let r = await api(u.jar, '/api/checkout/place-order', { method: 'POST', json, idemKey });
  if (r.status === 429) {
    const wait = ((r.body as { retryAfterSeconds?: number }).retryAfterSeconds ?? 65) + 1;
    console.log(`    (limiter, sleeping ${wait}s)`);
    await new Promise((res) => setTimeout(res, wait * 1000));
    r = await api(u.jar, '/api/checkout/place-order', { method: 'POST', json, idemKey });
  }
  return r;
}

// ─────────────────────────────────────────────── 5. UNIT TESTS

function unitTests() {
  console.log('\n── UNIT TESTS (lib/checkout/utr.ts) ──');

  // sanitizeUtr
  eq('sanitize: trim',              '425912345678', sanitizeUtr('   425912345678  '));
  eq('sanitize: dashes',            '425912345678', sanitizeUtr('4259-1234-5678'));
  eq('sanitize: spaces',            '425912345678', sanitizeUtr('4259 1234 5678'));
  eq('sanitize: uppercase',         'SBINN12345678901', sanitizeUtr('sbinn12345678901'));
  eq('sanitize: strip punctuation', 'SBINN12345678901', sanitizeUtr('SBIN.N/12345678901'));
  eq('sanitize: null  → ""',        '', sanitizeUtr(null));
  eq('sanitize: undef → ""',        '', sanitizeUtr(undefined));
  eq('sanitize: number 12345 → "12345"', '12345', sanitizeUtr(12345));
  eq('sanitize: empty → ""',        '', sanitizeUtr(''));

  // isPaymentMethod / PAYMENT_METHODS
  assert('isPaymentMethod("UPI")',  isPaymentMethod('UPI'));
  assert('isPaymentMethod("NEFT")', isPaymentMethod('NEFT'));
  assert('isPaymentMethod("CASH") = false', !isPaymentMethod('CASH'));
  assert('isPaymentMethod(123)   = false',  !isPaymentMethod(123));
  eq('PAYMENT_METHODS contents', ['UPI', 'IMPS', 'NEFT', 'RTGS'], [...PAYMENT_METHODS]);

  // validateUtrFormat — UPI / IMPS
  for (const m of ['UPI', 'IMPS'] as PaymentMethod[]) {
    assert(`${m}: accepts 12-digit '425912345678'`, validateUtrFormat('425912345678', m).ok);
    assert(`${m}: rejects 11-digit '42591234567'`,  !validateUtrFormat('42591234567', m).ok);
    assert(`${m}: rejects 13-digit '4259123456789'`,!validateUtrFormat('4259123456789', m).ok);
    assert(`${m}: rejects alpha 'SBIN12345678'`,    !validateUtrFormat('SBIN12345678', m).ok);
    assert(`${m}: rejects empty`,                    !validateUtrFormat('', m).ok);
  }

  // validateUtrFormat — NEFT (RBI canonical: <IFSC-4-letters>N<11-digits>)
  assert('NEFT: accepts SBINN12345678901',  validateUtrFormat('SBINN12345678901', 'NEFT').ok);
  assert('NEFT: accepts HDFCN98765432109',  validateUtrFormat('HDFCN98765432109', 'NEFT').ok);
  assert('NEFT: rejects lowercase shape',    !validateUtrFormat('sbinn12345678901', 'NEFT').ok);
  assert('NEFT: rejects 12-digit UPI shape', !validateUtrFormat('425912345678', 'NEFT').ok);
  assert('NEFT: rejects 4-digit IFSC missing letter', !validateUtrFormat('1234N12345678901', 'NEFT').ok);
  assert('NEFT: rejects R marker (RTGS shape)', !validateUtrFormat('SBINR12345678901', 'NEFT').ok);

  // validateUtrFormat — RTGS
  assert('RTGS: accepts 16-char SBINR12345678901', validateUtrFormat('SBINR12345678901', 'RTGS').ok);
  assert('RTGS: accepts 22-char SBINR12345678901234567', validateUtrFormat('SBINR12345678901234567', 'RTGS').ok);
  assert('RTGS: rejects 15-char (too short)', !validateUtrFormat('SBINR1234567890', 'RTGS').ok);
  assert('RTGS: rejects 23-char (too long)',  !validateUtrFormat('SBINR123456789012345678901', 'RTGS').ok);
  assert('RTGS: rejects N (NEFT marker)',     !validateUtrFormat('SBINN12345678901', 'RTGS').ok);

  // detectFraudPattern
  assert('fraud: rejects 000000000000',     !detectFraudPattern('000000000000').ok);
  assert('fraud: rejects 111111111111',     !detectFraudPattern('111111111111').ok);
  assert('fraud: rejects 999999999999',     !detectFraudPattern('999999999999').ok);
  assert('fraud: rejects 123456789012',     !detectFraudPattern('123456789012').ok);
  assert('fraud: rejects 987654321098',     !detectFraudPattern('987654321098').ok);
  assert('fraud: rejects "TEST12345678"',   !detectFraudPattern('TEST12345678').ok);
  assert('fraud: rejects "DEMO12345678"',   !detectFraudPattern('DEMO12345678').ok);
  assert('fraud: rejects "FAKE12345678"',   !detectFraudPattern('FAKE12345678').ok);
  assert('fraud: rejects 121212121212 (repeated 2-char block)',
         !detectFraudPattern('121212121212').ok);
  assert('fraud: ACCEPTS realistic 425912345678', detectFraudPattern('425912345678').ok);
  assert('fraud: ACCEPTS realistic SBINN98765432109', detectFraudPattern('SBINN98765432109').ok);
  assert('fraud: ACCEPTS 111222333444 (non-repeating 3-char blocks)',
         detectFraudPattern('111222333444').ok);

  // assertUtrAcceptable composite
  const a1 = assertUtrAcceptable('  425912345678 ', 'UPI');
  assert('assertAcceptable: valid UPI → ok=true', a1.ok);
  if (a1.ok) eq('assertAcceptable: sanitised correctly', '425912345678', a1.sanitized);

  const a2 = assertUtrAcceptable('000000000000', 'UPI');
  if (a2.ok) fail('assertAcceptable: all-zeros rejected', '!ok', a2);
  eq('assertAcceptable: all-zeros code = FRAUD_PATTERN', 'FRAUD_PATTERN', a2.code);

  const a3 = assertUtrAcceptable('12345678901', 'UPI'); // 11 digits
  if (a3.ok) fail('assertAcceptable: bad-format rejected', '!ok', a3);
  eq('assertAcceptable: bad-format code = BAD_FORMAT', 'BAD_FORMAT', a3.code);

  const a4 = assertUtrAcceptable('425912345678', 'BITCOIN' as unknown as PaymentMethod);
  if (a4.ok) fail('assertAcceptable: bad method rejected', '!ok', a4);
  eq('assertAcceptable: bad method code = BAD_METHOD', 'BAD_METHOD', a4.code);

  const a5 = assertUtrAcceptable('', 'UPI');
  if (a5.ok) fail('assertAcceptable: empty rejected', '!ok', a5);
  eq('assertAcceptable: empty code = EMPTY', 'EMPTY', a5.code);

  // maskUtr
  eq('mask: 12-digit', '********5678', maskUtr('425912345678'));
  eq('mask: 16-digit', '************8901', maskUtr('SBINN12345678901'));
  eq('mask: 4-char shows all stars', '****', maskUtr('ABCD'));
  eq('mask: 3-char shows all stars', '***', maskUtr('ABC'));
  eq('mask: null',  null, maskUtr(null));
  eq('mask: undef', null, maskUtr(undefined));
  eq('mask: empty', null, maskUtr(''));
  // mask preserves length so the receiver can tell which method
  const masked = maskUtr('SBINN12345678901');
  eq('mask: length preserved', 16, masked!.length);
}

// ─────────────────────────────────────────────── 6. INTEGRATION TESTS

let userA: TestUser; let userB: TestUser; let adminUserId = '';
// UTRs that need to outlive their owning test block (cross-block references).
let usedUtrFromX = '';   // set by integration test (x); reused by (xix) + (B)

async function loadAdmin() {
  // We bypass the admin OTP HTTP flow (out of scope for THIS bug) and call
  // verifyPayment() in-process with the seeded admin's id. The function
  // itself is the unit-under-test for the attestation contract.
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) throw new Error('No ADMIN user in DB — re-run seed.');
  adminUserId = admin.id;
}

async function integrationTests() {
  console.log('\n── INTEGRATION — customer place-order pipeline ──');

  const receiptA = await uploadReceipt(userA.jar);
  const legitBody = (utr: string, method: string = 'UPI', extras: Record<string, unknown> = {}) => ({
    shippingAddressId: userA.addressId,
    paymentMethod: method,
    utrNumber: utr,
    receiptUrl: receiptA,
    ...extras,
  });

  // (i) Default paymentMethod = UPI on the server — client may omit
  await freshCart(userA);
  const u_i = freshUpiUtr();
  const r_i = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId,
    utrNumber: u_i,
    receiptUrl: receiptA,
    // intentionally omit paymentMethod
  });
  eq('(i) omitted paymentMethod defaults to UPI → 200', 200, r_i.status);

  // (ii) Bad payment method
  await freshCart(userA);
  const r_ii = await placeOrderHttp(userA, legitBody(freshUpiUtr(), 'CASH'));
  eq('(ii) paymentMethod=CASH → 400', 400, r_ii.status);
  // The Zod enum catches CASH at the boundary; our composite would also catch it.

  // (iii) UPI body with NEFT-shaped UTR
  await freshCart(userA);
  const r_iii = await placeOrderHttp(userA, legitBody('SBINN12345678901', 'UPI'));
  eq('(iii) UPI + NEFT-shaped UTR → 400', 400, r_iii.status);
  eq('(iii) code = BAD_FORMAT', 'BAD_FORMAT', r_iii.body.code);

  // (iv) NEFT body with UPI-shaped UTR
  await freshCart(userA);
  const r_iv = await placeOrderHttp(userA, legitBody('425912345678', 'NEFT'));
  eq('(iv) NEFT + UPI-shaped UTR → 400', 400, r_iv.status);
  eq('(iv) code = BAD_FORMAT', 'BAD_FORMAT', r_iv.body.code);

  // (v) All zeros — fraud
  const beforeOrdersA = await prisma.order.count({ where: { userId: userA.userId } });
  await freshCart(userA);
  const r_v = await placeOrderHttp(userA, legitBody('000000000000', 'UPI'));
  eq('(v) all-zeros UTR → 400', 400, r_v.status);
  eq('(v) code = FRAUD_PATTERN', 'FRAUD_PATTERN', r_v.body.code);
  const afterOrdersA = await prisma.order.count({ where: { userId: userA.userId } });
  eq('(v) no order created', beforeOrdersA, afterOrdersA);

  // (vi) All sixes — fraud
  await freshCart(userA);
  const r_vi = await placeOrderHttp(userA, legitBody('666666666666', 'UPI'));
  eq('(vi) all-sixes UTR → 400', 400, r_vi.status);
  eq('(vi) code = FRAUD_PATTERN', 'FRAUD_PATTERN', r_vi.body.code);

  // (vii) Sequential 123456789012
  await freshCart(userA);
  const r_vii = await placeOrderHttp(userA, legitBody('123456789012', 'UPI'));
  eq('(vii) sequential UTR → 400', 400, r_vii.status);
  eq('(vii) code = FRAUD_PATTERN', 'FRAUD_PATTERN', r_vii.body.code);

  // (viii) "TEST12345678" — caught by format (not pure digits) AND/OR fraud
  await freshCart(userA);
  const r_viii = await placeOrderHttp(userA, legitBody('TEST12345678', 'UPI'));
  eq('(viii) "TEST..." UTR → 400', 400, r_viii.status);
  assert('(viii) code = BAD_FORMAT or FRAUD_PATTERN',
    r_viii.body.code === 'BAD_FORMAT' || r_viii.body.code === 'FRAUD_PATTERN',
    r_viii.body.code);

  // (ix) Whitespace-only UTR (Zod min(1) lets " " through; sanitiser strips to '')
  await freshCart(userA);
  const r_ix = await placeOrderHttp(userA, legitBody('   ', 'UPI'));
  eq('(ix) whitespace-only UTR → 400', 400, r_ix.status);
  eq('(ix) code = EMPTY', 'EMPTY', r_ix.body.code);

  // (x) Sanitisation roundtrip — '  XXXX-XXXX-XXXX  ' is stored as digits only.
  //     Use a fresh UTR so re-runs of the suite don't trip the global
  //     uniqueness constraint with leftover data.
  await freshCart(userA);
  const cleanX = freshUpiUtr();
  usedUtrFromX = cleanX;
  const dirty = `  ${cleanX.slice(0,4)}-${cleanX.slice(4,8)}-${cleanX.slice(8,12)}  `;
  const r_x = await placeOrderHttp(userA, legitBody(dirty, 'UPI'));
  eq('(x) dirty UTR → 200 after sanitisation', 200, r_x.status);
  const orderX = await prisma.order.findUniqueOrThrow({
    where: { id: (r_x.body.data as { orderId: string }).orderId },
  });
  eq('(x) stored UTR is sanitised', cleanX, orderX.utrNumber);
  // Confirm a UtrSubmission row exists with the same normalised value
  const subX = await prisma.utrSubmission.findUnique({ where: { utrNormalized: cleanX } });
  assert('(x) UtrSubmission row created with normalised value', !!subX);
  eq('(x) UtrSubmission raw preserves user input', dirty, subX!.utrSubmitted);

  // (xi) Lowercase NEFT — uppercased. Fresh UTR per run.
  await freshCart(userA);
  const neftUpper = freshNeftUtr();
  const neftLower = neftUpper.toLowerCase();
  const r_xi = await placeOrderHttp(userA, legitBody(neftLower, 'NEFT'));
  eq('(xi) lowercase NEFT → 200', 200, r_xi.status);
  const orderXi = await prisma.order.findUniqueOrThrow({
    where: { id: (r_xi.body.data as { orderId: string }).orderId },
  });
  eq('(xi) stored NEFT is uppercased', neftUpper, orderXi.utrNumber);

  // (xii) Same-user UTR reuse → 409
  // Place an order with a fresh UTR, then try to reuse the SAME UTR on a new order.
  await freshCart(userA);
  const reuseUtr = freshUpiUtr();
  const r_xii_1 = await placeOrderHttp(userA, legitBody(reuseUtr, 'UPI'));
  eq('(xii) seed order → 200', 200, r_xii_1.status);
  await freshCart(userA);
  const r_xii_2 = await placeOrderHttp(userA, legitBody(reuseUtr, 'UPI'));
  eq('(xii) re-use of same UTR by SAME user → 409', 409, r_xii_2.status);
  eq('(xii) code = DUPLICATE', 'DUPLICATE', r_xii_2.body.code);
  // Forensics: a REJECTED_DUPLICATE row was added
  const dupCount = await prisma.utrSubmission.count({
    where: { userId: userA.userId, status: 'REJECTED_DUPLICATE' },
  });
  assert('(xii) REJECTED_DUPLICATE row in UtrSubmission for forensics', dupCount >= 1, { dupCount });

  // (xiii) Cross-user UTR sharing fraud → 409 for user B
  await freshCart(userA);
  const sharedUtr = freshUpiUtr();
  const r_xiii_A = await placeOrderHttp(userA, legitBody(sharedUtr, 'UPI'));
  eq('(xiii) user A places order with UTR → 200', 200, r_xiii_A.status);
  // user B tries the SAME utr
  const receiptB = await uploadReceipt(userB.jar);
  await freshCart(userB);
  const r_xiii_B = await placeOrderHttp(userB, {
    shippingAddressId: userB.addressId,
    paymentMethod: 'UPI',
    utrNumber: sharedUtr,
    receiptUrl: receiptB,
  });
  eq('(xiii) user B reuses A\'s UTR → 409', 409, r_xiii_B.status);
  eq('(xiii) user B code = DUPLICATE', 'DUPLICATE', r_xiii_B.body.code);

  // (xiv) Concurrent UTR-reuse race: two parallel POSTs with same UTR but
  //       DIFFERENT idempotency keys (so idempotency layer doesn't dedupe).
  //       Exactly one must succeed; the other must be a 409 duplicate.
  await freshCart(userA);
  const raceUtr = freshUpiUtr();
  const before = await prisma.order.count({ where: { userId: userA.userId } });
  // Place two carts? Actually each placeOrder consumes the cart; for a fair
  // race we add one item, then issue two parallel POSTs. The second one will
  // also fail because the cart was already cleared — BUT that's a CART_EMPTY
  // failure, not a UTR test. To exercise UTR uniqueness specifically, we run
  // the second call with a fresh cart added between the two POSTs.
  // Simpler: do the two calls sequentially — already covered in (xii).
  // For real concurrency, we use TWO users (A and B), B uses A's UTR while
  // A's order is mid-flight.
  await freshCart(userA);
  await freshCart(userB);
  const concurrentResults = await Promise.all([
    placeOrderHttp(userA, { shippingAddressId: userA.addressId, paymentMethod: 'UPI', utrNumber: raceUtr, receiptUrl: receiptA }),
    placeOrderHttp(userB, { shippingAddressId: userB.addressId, paymentMethod: 'UPI', utrNumber: raceUtr, receiptUrl: receiptB }),
  ]);
  const successCount = concurrentResults.filter((r) => r.status === 200).length;
  const dupRejectCount = concurrentResults.filter((r) => r.status === 409 && r.body.code === 'DUPLICATE').length;
  eq('(xiv) concurrent UTR race: exactly 1 success', 1, successCount);
  eq('(xiv) concurrent UTR race: exactly 1 DUPLICATE rejection', 1, dupRejectCount);
  const afterRace = await prisma.order.count({
    where: { OR: [{ userId: userA.userId }, { userId: userB.userId }], utrNumber: raceUtr },
  });
  eq('(xiv) DB has exactly 1 order with that UTR', 1, afterRace);
  void before;

  // (xv) GET /api/orders/[id] returns MASKED utr — derived from cleanX (UPI=12 digits)
  const orderListing = await api(userA.jar, `/api/orders/${orderX.id}`);
  eq('(xv) order detail returns 200', 200, orderListing.status);
  const returnedOrder = (orderListing.body.data as { order: { utrNumber: string | null; utrNumberMasked: string | null } }).order;
  const expectedMask = '*'.repeat(cleanX.length - 4) + cleanX.slice(-4);
  eq('(xv) utrNumber field is MASKED',         expectedMask, returnedOrder.utrNumber);
  eq('(xv) utrNumberMasked field also masked', expectedMask, returnedOrder.utrNumberMasked);
  assert('(xv) raw UTR is NOT leaked in body', !JSON.stringify(orderListing.body).includes(cleanX),
    `raw UTR ${cleanX} found in body`);

  // (xvi) GET /api/orders list also masks
  const list = await api(userA.jar, '/api/orders');
  const orders = (list.body.data as { orders: { utrNumber: string | null }[] }).orders;
  for (const o of orders) {
    if (o.utrNumber) assert(`(xvi) listed order UTR masked: ${o.utrNumber}`,
      /^\*+\w{4}$/.test(o.utrNumber), o.utrNumber);
  }

  console.log('\n── INTEGRATION — admin verify-payment pipeline (in-process) ──');

  // For the admin tests, target the order from (x) (still PENDING_PAYMENT_REVIEW)
  const adminTargetOrderId = orderX.id;

  // (xvii) amountMatches=false → rejected
  const r_xvii = await verifyPayment(adminUserId, adminTargetOrderId, 'just testing', { amountMatches: false });
  assert('(xvii) amountMatches=false → not ok', !r_xvii.ok);
  if (!r_xvii.ok) {
    assert('(xvii) error mentions attestation',
      r_xvii.reason.toLowerCase().includes('amountmatches') ||
      r_xvii.reason.toLowerCase().includes('attest'),
      r_xvii.reason);
  }

  // (xviii) attestation omitted entirely → rejected
  const r_xviii = await verifyPayment(adminUserId, adminTargetOrderId, 'no attestation field');
  assert('(xviii) attestation missing → not ok', !r_xviii.ok);

  // (xix) Bank-reference matching → verifies. We use the UTR stored on
  //       the order itself (cleanX from test (x)) so this is round-trip safe.
  const r_xix = await verifyPayment(adminUserId, adminTargetOrderId, 'matches', {
    amountMatches: true, bankReference: cleanX,
  });
  assert('(xix) amountMatches=true + matching bankRef → ok', r_xix.ok);
  // Order is now VERIFIED
  const verified = await prisma.order.findUniqueOrThrow({ where: { id: adminTargetOrderId } });
  eq('(xix) paymentStatus = VERIFIED', 'VERIFIED', verified.paymentStatus);
  assert('(xix) amountVerifiedAt is set', !!verified.amountVerifiedAt);
  const subVerified = await prisma.utrSubmission.findUnique({ where: { utrNormalized: cleanX } });
  eq('(xix) UtrSubmission.status = VERIFIED', 'VERIFIED', subVerified?.status);
  assert('(xix) UtrSubmission.verifiedAt is set', !!subVerified?.verifiedAt);

  // (xx) Mismatched bank-reference on a DIFFERENT order → rejection
  // Use the order from (xi) (NEFT, still PENDING_PAYMENT_REVIEW)
  const r_xx = await verifyPayment(adminUserId, orderXi.id, 'mismatched on purpose', {
    amountMatches: true, bankReference: 'WRONGREF99',
  });
  assert('(xx) mismatched bankRef → not ok', !r_xx.ok);
  if (!r_xx.ok) {
    assert('(xx) error mentions bank-statement / UTR mismatch',
      r_xx.reason.toLowerCase().includes('does not match'),
      r_xx.reason);
  }
  const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: orderXi.id } });
  eq('(xx) order remains AWAITING_VERIFICATION', 'AWAITING_VERIFICATION', stillPending.paymentStatus);

  // (xxi) Forensics — every rejected attempt left a UtrSubmission row with
  //       its raw input and a code-shaped status. Inspect a couple.
  const rejFormat = await prisma.utrSubmission.count({ where: { userId: userA.userId, status: 'REJECTED_FORMAT' } });
  const rejFraud  = await prisma.utrSubmission.count({ where: { userId: userA.userId, status: 'REJECTED_FRAUD' } });
  const rejDup    = await prisma.utrSubmission.count({ where: { userId: userA.userId, status: 'REJECTED_DUPLICATE' } });
  assert(`(xxi) REJECTED_FORMAT count > 0 (got ${rejFormat})`,    rejFormat > 0);
  assert(`(xxi) REJECTED_FRAUD  count > 0 (got ${rejFraud})`,     rejFraud > 0);
  assert(`(xxi) REJECTED_DUPLICATE count > 0 (got ${rejDup})`,    rejDup > 0);
}

// ─────────────────────────────────────────────── 7. REGRESSION

async function regressionTests() {
  console.log('\n── REGRESSION (bug-class scenarios) ──');

  const receipt = await uploadReceipt(userA.jar);

  // (A) Fake UTR "000000000000"
  await freshCart(userA);
  const beforeA = await prisma.order.count({ where: { userId: userA.userId } });
  const rA = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId, paymentMethod: 'UPI',
    utrNumber: '000000000000', receiptUrl: receipt,
  });
  eq('(A) fake all-zero UTR → 400', 400, rA.status);
  eq('(A) no order created', beforeA, await prisma.order.count({ where: { userId: userA.userId } }));

  // (B) Reuse of past UTR (we already verified order from (x) — try its UTR again)
  await freshCart(userA);
  const rB = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId, paymentMethod: 'UPI',
    utrNumber: usedUtrFromX, receiptUrl: receipt,
  });
  eq('(B) reuse of past UTR (already verified) → 409', 409, rB.status);
  eq('(B) code = DUPLICATE', 'DUPLICATE', rB.body.code);

  // (C) Cross-account sharing (already in xiii but assert from regression POV)
  const sharedC = freshUpiUtr();
  await freshCart(userA);
  const rC_A = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId, paymentMethod: 'UPI',
    utrNumber: sharedC, receiptUrl: receipt,
  });
  eq('(C) user A places with new UTR → 200', 200, rC_A.status);
  const receiptB = await uploadReceipt(userB.jar);
  await freshCart(userB);
  const rC_B = await placeOrderHttp(userB, {
    shippingAddressId: userB.addressId, paymentMethod: 'UPI',
    utrNumber: sharedC, receiptUrl: receiptB,
  });
  eq('(C) user B tries to share that UTR → 409', 409, rC_B.status);
  eq('(C) code = DUPLICATE', 'DUPLICATE', rC_B.body.code);

  // (D) Random alphanumeric typing for UPI (must be digits-only-12)
  await freshCart(userA);
  const rD = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId, paymentMethod: 'UPI',
    utrNumber: 'XXXX1234XXXX', receiptUrl: receipt,
  });
  eq('(D) random alphanumeric for UPI → 400', 400, rD.status);
  eq('(D) code = BAD_FORMAT', 'BAD_FORMAT', rD.body.code);

  // (E) Sanitisation roundtrip from a "real-looking" customer paste with
  //     mixed dashes/spaces/case — must store cleanly.
  await freshCart(userA);
  const dirty = `${freshUpiUtr().slice(0, 4)}-${freshUpiUtr().slice(0, 4)}-${freshUpiUtr().slice(0, 4)}`;
  // build a clean 12-digit ourselves to know the expected normalised value
  const cleanE = freshUpiUtr();
  const presentation = `${cleanE.slice(0,4)} ${cleanE.slice(4,8)} ${cleanE.slice(8,12)}`;
  const rE = await placeOrderHttp(userA, {
    shippingAddressId: userA.addressId, paymentMethod: 'UPI',
    utrNumber: presentation, receiptUrl: receipt,
  });
  eq('(E) spaced/grouped UTR → 200 after sanitisation', 200, rE.status);
  const orderE = await prisma.order.findUniqueOrThrow({
    where: { id: (rE.body.data as { orderId: string }).orderId },
  });
  eq('(E) stored UTR matches normalised value', cleanE, orderE.utrNumber);
  void dirty;
}

// ─────────────────────────────────────────────── 8. CLEANUP

async function cleanup() {
  console.log('\n── cleanup ──');
  // Be exhaustive: ALSO sweep any leftover test users from a prior crashed
  // run (matches our email prefix). Defensive against the user-not-found
  // case where in-memory references point to deleted rows.
  const sweepUsers = await prisma.user.findMany({
    where: { email: { startsWith: 'utr_' } },
    select: { id: true, email: true },
  });
  console.log(`  cleaning up ${sweepUsers.length} test user(s) matching utr_*`);
  for (const u of sweepUsers) {
    try {
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
      // Don't fail the suite over cleanup — surface the message and keep going.
      console.error(`  cleanup failed for ${u.email}: ${(e as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────── MAIN

async function main() {
  writeFileSync('/tmp/test-utr.log', '');
  console.log(`Starting test server on :${PORT}…`);
  await startServer();
  try {
    console.log('Preparing fixture…');
    await pickProduct();
    userA = await signupAndVerify('A');
    userB = await signupAndVerify('B');
    await loadAdmin();
    ok(`fixture ready: ${userA.email}, ${userB.email}, admin=${adminUserId.slice(0,8)}…`);

    unitTests();
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
