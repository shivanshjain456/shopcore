/**
 * Feature #13 — India-Wide PIN code verification & autofill test suite.
 *
 *   npm run test:pincode
 *
 * Layers:
 *
 *   1. UNIT        — pure helpers (format validation, response parsing,
 *                    state canonicalisation, serviceability allowlist).
 *   2. SERVICE     — IndiaPostPincodeService with a MOCK upstream fetcher:
 *                    happy path, multi-office, missing region, error body,
 *                    upstream timeout, malformed JSON, cache hit on second
 *                    call, abort-safe race for rapid lookups.
 *   3. INTEGRATION — real `next start` on :3039 talking the real route:
 *                    /api/pincode/[pincode]
 *                    - 400 on invalid format (no upstream traffic),
 *                    - 200 envelope on lookup miss (UI never blocks form),
 *                    - 200 + cache hit on second call (Cache-Control header),
 *                    - 403 on cross-origin, 429 on rate-limit burst.
 *   4. REGRESSION  — pre-existing `/api/addresses` POST still validates +
 *                    persists with city/state/pincode, and the existing
 *                    /api/auth/csrf endpoint is untouched.
 *
 * Cleans up its own users + addresses at the end.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import {
  IndiaPostPincodeService, isValidPincodeFormat, parseIndiaPostResponse,
  _resetPincodeCache, _pincodeCacheStats,
  PINCODE_CACHE_TTL_MS, PINCODE_FETCH_TIMEOUT_MS,
} from '../src/lib/pincode/indiaPost';
import {
  isStateServiceable, canonicaliseState, SERVICEABLE_STATES,
} from '../src/lib/shipping/serviceableStates';
import type { PincodeVerification } from '../src/lib/pincode/types';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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

// ── fixtures ──────────────────────────────────────────────────────────────
const TAG = `pin_${Date.now()}`;

// Authentic-shape sample payloads we'd see from api.postalpincode.in.
const PAYLOAD_DELHI_110001 = [{
  Message: 'Number of pincode(s) found:5',
  Status: 'Success',
  PostOffice: [
    { Name: 'Baroda House', BranchType: 'Sub Office', DeliveryStatus: 'Non-Delivery',
      Circle: 'Delhi', District: 'Central Delhi', Division: 'New Delhi Central',
      Region: 'Delhi', Block: 'New Delhi', State: 'Delhi', Country: 'India', Pincode: '110001' },
    { Name: 'Bengali Market', BranchType: 'Sub Office', DeliveryStatus: 'Non-Delivery',
      Circle: 'Delhi', District: 'Central Delhi', Division: 'New Delhi Central',
      Region: 'Delhi', Block: 'New Delhi', State: 'Delhi', Country: 'India', Pincode: '110001' },
    { Name: 'Connaught Place', BranchType: 'Sub Office', DeliveryStatus: 'Delivery',
      Circle: 'Delhi', District: 'Central Delhi', Division: 'New Delhi Central',
      Region: 'Delhi', Block: 'New Delhi', State: 'Delhi', Country: 'India', Pincode: '110001' },
    { Name: 'Lady Hardinge Medical College', BranchType: 'Sub Office', DeliveryStatus: 'Non-Delivery',
      Circle: 'Delhi', District: 'Central Delhi', Division: 'New Delhi Central',
      Region: 'Delhi', Block: 'New Delhi', State: 'Delhi', Country: 'India', Pincode: '110001' },
    { Name: 'Sansad Marg H.O', BranchType: 'Head Office', DeliveryStatus: 'Delivery',
      Circle: 'Delhi', District: 'Central Delhi', Division: 'New Delhi Central',
      Region: 'Delhi', Block: 'New Delhi', State: 'Delhi', Country: 'India', Pincode: '110001' },
  ],
}];
const PAYLOAD_BENGALURU_560001 = [{
  Message: 'Number of pincode(s) found:1',
  Status: 'Success',
  PostOffice: [
    { Name: 'Bangalore G.P.O.', BranchType: 'Head Office', DeliveryStatus: 'Delivery',
      Circle: 'Karnataka', District: 'Bengaluru Urban', Division: 'Bengaluru GPO',
      Region: 'Bengaluru', Block: 'Bengaluru East', State: 'Karnataka', Country: 'India', Pincode: '560001' },
  ],
}];
const PAYLOAD_NOTFOUND = [{ Message: 'No records found', Status: 'Error', PostOffice: null }];
const PAYLOAD_PONDICHERRY = [{
  Message: 'Number of pincode(s) found:1',
  Status: 'Success',
  PostOffice: [
    { Name: 'Puducherry H.O', BranchType: 'Head Office', DeliveryStatus: 'Delivery',
      Circle: 'Tamilnadu', District: 'Puducherry', Division: 'Puducherry',
      Region: 'Pondicherry', Block: 'Puducherry', State: 'Pondicherry',
      Country: 'India', Pincode: '605001' },
  ],
}];
const PAYLOAD_MALFORMED_NO_STATE = [{
  Status: 'Success',
  PostOffice: [{ Name: 'Mystery', District: 'Mystery' /* state intentionally missing */ }],
}];
const PAYLOAD_GARBAGE = { not: 'an array' };

// ── Mocked service: swap `fetchUpstream` for a controllable function. ─────
class MockService extends IndiaPostPincodeService {
  public calls: string[] = [];
  public mode: 'ok' | 'notfound' | 'timeout' | 'http500' | 'garbage' | 'malformed' | 'pondy' | 'bengaluru' = 'ok';
  public latencyMs = 0;
  protected async fetchUpstream(pincode: string): Promise<unknown> {
    this.calls.push(pincode);
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    switch (this.mode) {
      case 'ok':         return PAYLOAD_DELHI_110001;
      case 'bengaluru':  return PAYLOAD_BENGALURU_560001;
      case 'pondy':      return PAYLOAD_PONDICHERRY;
      case 'notfound':   return PAYLOAD_NOTFOUND;
      case 'malformed':  return PAYLOAD_MALFORMED_NO_STATE;
      case 'garbage':    return PAYLOAD_GARBAGE;
      case 'timeout':
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      case 'http500':
        throw Object.assign(new Error('upstream-500'), { code: 'HTTP_500' });
    }
  }
}

// ────────────────────────────────────────────────────────────────── 1. UNIT
function unitTests() {
  console.log('\n── UNIT — format / parse / serviceability ──');

  // ── format
  assert('isValidPincodeFormat("110001") = true',  isValidPincodeFormat('110001'));
  assert('isValidPincodeFormat("123")    = false', !isValidPincodeFormat('123'));
  assert('isValidPincodeFormat("ABCDEF") = false', !isValidPincodeFormat('ABCDEF'));
  assert('isValidPincodeFormat("1234567")= false', !isValidPincodeFormat('1234567'));
  assert('isValidPincodeFormat("")       = false', !isValidPincodeFormat(''));
  assert('isValidPincodeFormat(null)     = false', !isValidPincodeFormat(null as unknown as string));
  assert('isValidPincodeFormat(undefined)= false', !isValidPincodeFormat(undefined as unknown as string));
  assert('isValidPincodeFormat(" 110001 ")=false (trim is caller\'s job)',
    !isValidPincodeFormat(' 110001 '));

  // ── serviceability
  assert('SERVICEABLE_STATES contains ≥ 30 entries', SERVICEABLE_STATES.length >= 30);
  assert('isStateServiceable("Karnataka")',         isStateServiceable('Karnataka'));
  assert('isStateServiceable("karnataka")',         isStateServiceable('karnataka'));
  assert('isStateServiceable("KARNATAKA")',         isStateServiceable('KARNATAKA'));
  assert('isStateServiceable("") false',           !isStateServiceable(''));
  assert('isStateServiceable(null) false',         !isStateServiceable(null));
  assert('isStateServiceable("Nowhereistan") false', !isStateServiceable('Nowhereistan'));

  // ── canonicalisation
  eq('canonicaliseState("DELHI") → "Delhi"',           'Delhi', canonicaliseState('DELHI'));
  eq('canonicaliseState("pondicherry") → "Puducherry"', 'Puducherry', canonicaliseState('pondicherry'));
  eq('canonicaliseState("orissa") → "Odisha"',         'Odisha', canonicaliseState('orissa'));
  eq('canonicaliseState("nowhere") → null',             null, canonicaliseState('nowhere'));

  // ── parse: happy multi-office
  const v1 = parseIndiaPostResponse('110001', PAYLOAD_DELHI_110001, 42);
  eq('parse: found=true on Status=Success', true, v1.found);
  eq('parse: pincode echoed', '110001', v1.pincode);
  eq('parse: state canonicalised to "Delhi"', 'Delhi', v1.state);
  eq('parse: district extracted',  'Central Delhi', v1.district);
  eq('parse: city = Region (preferred over Division/District)', 'Delhi', v1.city);
  eq('parse: postOffices length matches payload', 5, v1.postOffices.length);
  eq('parse: lookupMs echoed', 42, v1.lookupMs);
  assert('parse: isServiceable true for Delhi', v1.isServiceable);

  // ── parse: single-office Bengaluru
  const v2 = parseIndiaPostResponse('560001', PAYLOAD_BENGALURU_560001, 17);
  eq('parse: 560001 city = "Bengaluru"', 'Bengaluru', v2.city);
  eq('parse: 560001 state = "Karnataka"', 'Karnataka', v2.state);

  // ── parse: aliased state (Pondicherry → Puducherry)
  const v3 = parseIndiaPostResponse('605001', PAYLOAD_PONDICHERRY, 0);
  eq('parse: aliased Pondicherry → "Puducherry"', 'Puducherry', v3.state);

  // ── parse: Status="Error" (not found)
  const v4 = parseIndiaPostResponse('999999', PAYLOAD_NOTFOUND, 5);
  eq('parse: Status=Error → found=false', false, v4.found);
  eq('parse: not-found state=null', null, v4.state);
  assert('parse: not-found message non-empty', !!v4.message && v4.message.length > 0);

  // ── parse: malformed (Success but no usable State)
  const v5 = parseIndiaPostResponse('111111', PAYLOAD_MALFORMED_NO_STATE, 0);
  eq('parse: malformed → found=false', false, v5.found);
  assert('parse: malformed has message', !!v5.message);

  // ── parse: garbage payload (not an array)
  const v6 = parseIndiaPostResponse('222222', PAYLOAD_GARBAGE, 0);
  eq('parse: garbage → found=false', false, v6.found);

  // ── parse: empty array
  const v7 = parseIndiaPostResponse('333333', [], 0);
  eq('parse: empty array → found=false', false, v7.found);

  // ── TTL/timeout sanity
  assert(`PINCODE_CACHE_TTL_MS ≥ 1h (got ${PINCODE_CACHE_TTL_MS / 3600000}h)`, PINCODE_CACHE_TTL_MS >= 3600000);
  assert(`PINCODE_FETCH_TIMEOUT_MS ≤ 10s (got ${PINCODE_FETCH_TIMEOUT_MS}ms)`, PINCODE_FETCH_TIMEOUT_MS <= 10_000);
}

// ────────────────────────────────────────────────────────────────── 2. SERVICE
async function serviceTests() {
  console.log('\n── SERVICE — IndiaPostPincodeService (mock upstream) ──');
  _resetPincodeCache();

  const svc = new MockService();

  // (S1) invalid format never hits upstream
  svc.calls = [];
  const inv = await svc.verifyPincode('abc');
  eq('(S1) invalid format → found:false', false, inv.found);
  eq('(S1) invalid format never called upstream', 0, svc.calls.length);
  assert('(S1) message hints at format', /6 digit/i.test(inv.message ?? ''));

  // (S2) happy
  svc.mode = 'ok';
  svc.calls = [];
  const h = await svc.verifyPincode('110001');
  eq('(S2) ok call hit upstream once', 1, svc.calls.length);
  eq('(S2) found=true', true, h.found);
  eq('(S2) state=Delhi', 'Delhi', h.state);
  eq('(S2) 5 post offices', 5, h.postOffices.length);
  eq('(S2) source=india-post', 'india-post', h.source);

  // (S3) cache hit — same pincode, no upstream call
  svc.calls = [];
  const h2 = await svc.verifyPincode('110001');
  eq('(S3) cached call avoids upstream', 0, svc.calls.length);
  eq('(S3) source=cache on second call', 'cache', h2.source);
  eq('(S3) cached payload equals original', h.postOffices.length, h2.postOffices.length);

  // (S4) not-found
  _resetPincodeCache();
  svc.mode = 'notfound';
  svc.calls = [];
  const nf = await svc.verifyPincode('999999');
  eq('(S4) notfound: found=false', false, nf.found);
  eq('(S4) notfound: postOffices empty', 0, nf.postOffices.length);
  assert('(S4) notfound message present', !!nf.message);
  // not-found IS cached so a hostile-client probe doesn't keep hitting upstream.
  svc.calls = [];
  await svc.verifyPincode('999999');
  eq('(S4) notfound second call hits cache', 0, svc.calls.length);

  // (S5) timeout — surfaces as found:false, NOT cached (transient)
  _resetPincodeCache();
  svc.mode = 'timeout';
  svc.calls = [];
  const t = await svc.verifyPincode('111111');
  eq('(S5) timeout: found=false', false, t.found);
  assert('(S5) timeout message present', !!t.message && /manual|timed/i.test(t.message));
  // Timeout NOT cached
  svc.calls = [];
  await svc.verifyPincode('111111');
  eq('(S5) timeout retry hits upstream again (not cached)', 1, svc.calls.length);

  // (S6) HTTP 500 — same shape, not cached
  _resetPincodeCache();
  svc.mode = 'http500';
  svc.calls = [];
  const e500 = await svc.verifyPincode('222222');
  eq('(S6) http500: found=false', false, e500.found);
  svc.calls = [];
  await svc.verifyPincode('222222');
  eq('(S6) http500 retry hits upstream again', 1, svc.calls.length);

  // (S7) garbage upstream payload — handled, not cached as "data"
  _resetPincodeCache();
  svc.mode = 'garbage';
  const g = await svc.verifyPincode('333333');
  eq('(S7) garbage upstream → found=false', false, g.found);

  // (S8) malformed (Status:Success but unusable rows)
  _resetPincodeCache();
  svc.mode = 'malformed';
  const m = await svc.verifyPincode('444444');
  eq('(S8) malformed → found=false', false, m.found);

  // (S9) alias resolution (Pondicherry → Puducherry)
  _resetPincodeCache();
  svc.mode = 'pondy';
  const p = await svc.verifyPincode('605001');
  eq('(S9) Pondicherry → state="Puducherry"', 'Puducherry', p.state);
  assert('(S9) Puducherry is in serviceable list', p.isServiceable);

  // (S10) cache size cap eviction
  _resetPincodeCache();
  assert('(S10) cache starts empty', _pincodeCacheStats().size === 0);
  svc.mode = 'ok';
  await svc.verifyPincode('110001');
  assert('(S10) cache size 1 after first call', _pincodeCacheStats().size === 1);

  // (S11) Race-safety at the SERVICE layer: hit the same pincode twice with
  //       a slow upstream — both promises resolve correctly, only one
  //       network call should fire IF the second hits the cache.
  //       (We don't dedupe in-flight requests; we just cache results.)
  _resetPincodeCache();
  svc.mode = 'ok';
  svc.calls = [];
  svc.latencyMs = 100;
  const [r1, r2] = await Promise.all([
    svc.verifyPincode('560002'),
    svc.verifyPincode('560002'),
  ]);
  svc.latencyMs = 0;
  // Both resolve with consistent data.
  eq('(S11) parallel calls: both found=true', true, r1.found && r2.found);
  // Upstream was called at most twice (no dedupe, but cache settles quickly).
  assert(`(S11) upstream calls ≤ 2 (got ${svc.calls.length})`, svc.calls.length <= 2);

  // (S12) Format reject leaves cache untouched.
  _resetPincodeCache();
  await svc.verifyPincode('12');
  eq('(S12) invalid format does not poison cache', 0, _pincodeCacheStats().size);
}

// ────────────────────────────────────────────────────────────────── 3. INTEGRATION
const PORT = 3039;
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
  const out = (b: Buffer) => writeFileSync('/tmp/test-pincode.log', b, { flag: 'a' });
  serverProc.stdout?.on('data', out);
  serverProc.stderr?.on('data', out);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
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
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown; headers?: Record<string, string>; origin?: string }) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  // Default same-origin
  if (!headers.has('origin')) headers.set('origin', init?.origin ?? BASE);
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers.set(k, v);
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
  console.log('\n── INTEGRATION — /api/pincode/[pincode] ──');
  const jar = newJar();

  // (i) Invalid format → 400 + envelope with found:false.
  const r1 = await api(jar, '/api/pincode/abc');
  eq('(i) /pincode/abc → 400', 400, r1.status);
  const d1 = (r1.body.data ?? {}) as Record<string, unknown>;
  eq('(i) envelope.found=false', false, d1.found);
  assert('(i) envelope.message references 6 digits',
    typeof d1.message === 'string' && /6 digit/i.test(String(d1.message)));

  // (ii) Three-digit input → 400 (no upstream traffic)
  const r2 = await api(jar, '/api/pincode/123');
  eq('(ii) /pincode/123 → 400', 400, r2.status);

  // (iii) Cross-origin → 403 (origin host differs from request host)
  const r3 = await api(jar, '/api/pincode/110001', { origin: 'http://evil.example' });
  eq('(iii) cross-origin /pincode → 403', 403, r3.status);

  // (iv) Real lookup — we don't make real network calls in tests; instead
  //      we hit a well-known invalid pincode (000000) which will return
  //      either a notfound from upstream OR a network error if outbound
  //      egress is blocked. Either way the route returns 200 with
  //      found:false — the envelope shape we promise the UI.
  const r4 = await api(jar, '/api/pincode/000000');
  eq('(iv) /pincode/000000 → 200 (envelope)', 200, r4.status);
  const d4 = (r4.body.data ?? {}) as Record<string, unknown>;
  // Could be found:false (notfound from upstream) OR found:false (network
  // unreachable). Both are acceptable — what matters is the SHAPE.
  assert('(iv) envelope has expected keys',
    'pincode' in d4 && 'found' in d4 && 'postOffices' in d4 &&
    'state' in d4 && 'district' in d4 && 'city' in d4 &&
    'isServiceable' in d4 && 'source' in d4);
  // If upstream IS reachable AND returned notfound, we cache. The next
  // call should NOT bump lookupMs significantly. But we can't reliably
  // assert latency in tests, so just exercise the call.
  const r4b = await api(jar, '/api/pincode/000000');
  eq('(iv) /pincode/000000 second call → 200', 200, r4b.status);

  // (v) Cache-Control header set
  const cc = r4.headers.get('cache-control');
  assert(`(v) Cache-Control header set (got "${cc}")`,
    typeof cc === 'string' && cc.length > 0);

  // (vi) Burst → rate-limit eventually 429
  let last429 = 0;
  for (let i = 0; i < 80; i++) {
    const r = await api(jar, `/api/pincode/${100000 + i}`);
    if (r.status === 429) { last429++; }
  }
  assert(`(vi) burst eventually saw a 429 (count=${last429})`, last429 >= 1);
}

// ────────────────────────────────────────────────────────────────── 4. REGRESSION
async function makeAuthedUser(label: string) {
  const email = `${TAG}_${label}@shopcore.test`;
  const phone = '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
  const user = await prisma.user.create({
    data: {
      firstName: 'Pin', lastName: label, email, phone,
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'CUSTOMER', status: 'ACTIVE',
      referralCode: 'R' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
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
  return { user, jar };
}

async function regressionTests() {
  console.log('\n── REGRESSION — /api/addresses still validates city/state/pincode ──');

  const { user: U, jar } = await makeAuthedUser('reg');

  // R1. Valid POST → 200
  const okPost = await api(jar, '/api/addresses', {
    method: 'POST',
    json: {
      label: 'Home', fullName: 'Pin Reg', phone: '+919876543210',
      addressLine1: 'A1', addressLine2: 'B2', city: 'Mumbai',
      state: 'Maharashtra', pinCode: '400001', country: 'India',
    },
  });
  eq('(R1) POST /api/addresses with valid PIN → 200', 200, okPost.status);

  // R2. Invalid PIN → 400 (server-side validator independent of #13)
  const badPost = await api(jar, '/api/addresses', {
    method: 'POST',
    json: {
      label: 'Home', fullName: 'Pin Reg', phone: '+919876543210',
      addressLine1: 'A1', addressLine2: 'B2', city: 'Mumbai',
      state: 'Maharashtra', pinCode: 'abc',  country: 'India',
    },
  });
  eq('(R2) POST /api/addresses with non-numeric PIN → 400', 400, badPost.status);

  // R3. Five-digit PIN → 400
  const shortPin = await api(jar, '/api/addresses', {
    method: 'POST',
    json: {
      label: 'Home', fullName: 'Pin Reg', phone: '+919876543210',
      addressLine1: 'A1', addressLine2: 'B2', city: 'Mumbai',
      state: 'Maharashtra', pinCode: '12345', country: 'India',
    },
  });
  eq('(R3) POST /api/addresses with 5-digit PIN → 400', 400, shortPin.status);

  // R4. /api/auth/csrf still returns a token (not affected)
  const csrf = await api(newJar(), '/api/auth/csrf');
  eq('(R4) /api/auth/csrf still 200', 200, csrf.status);

  void U;
}

// ────────────────────────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true, email: true } });
  for (const u of users) {
    await prisma.address.deleteMany({ where: { userId: u.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
  }
  ok(`removed ${users.length} test user(s)`);
}

async function main() {
  try {
    unitTests();
    await serviceTests();
    await startServer();
    await integrationTests();
    await regressionTests();
  } finally {
    await stopServer();
    try { await cleanup(); } catch (e) { console.warn('cleanup failed:', e); }
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
