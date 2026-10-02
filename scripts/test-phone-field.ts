/**
 * PhoneField + canonical normaliser — Item 9. Test harness.
 *
 *   npm run test:phone-field
 *
 * Sections:
 *   1. UNIT     — pure functions (normalisePhone, isValidIndianMobile,
 *                 formatPhone, maskPhoneForDisplay, stripIndianPrefix).
 *   2. STATIC   — file presence; one-and-only-one definition of
 *                 normalisePhone; no rogue `type="tel"` inputs outside
 *                 the canonical PhoneField; every API phone field uses
 *                 the canonical phoneSchema.
 *   3. INTEGRATION — spawn `next start`, hit the gated endpoints with
 *                 permissive phone formats, assert each is normalised
 *                 to E.164 in the DB.
 *
 * No jsdom in this harness — the project's other test scripts use
 * static + integration coverage rather than a DOM mounter, and the
 * PhoneField is small enough that its display-derivation + paste
 * normalisation logic is fully exercisable through its inputs to the
 * canonical normaliser (which we DO unit-test exhaustively).
 *
 * Every assertion carries a [P<n>.<m>] tag mapping to the spec section.
 */
// Pre-import side-effects.
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import {
  normalisePhone, isValidIndianMobile, formatPhone,
  maskPhoneForDisplay, stripIndianPrefix,
} from '../src/lib/utils/phone';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  if (existsSync(SRV_LOG)) {
    const tail = readFileSync(SRV_LOG, 'utf-8').split('\n').slice(-10).join('\n');
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

const TAG = `pf_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

const PORT = 3065;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-phone-field-${process.pid}.log`;

// ─────────────────────────────────────────────────────── 1. UNIT — pure fns

function unitTests(): void {
  console.log('\n── UNIT — pure phone utilities ──');

  // (P1.1) normalisePhone — spec §4.1 accept list
  const acceptCases: Array<[string, string]> = [
    ['9876543210',           '+919876543210'],
    ['09876543210',          '+919876543210'],
    ['919876543210',         '+919876543210'],
    ['+919876543210',        '+919876543210'],
    ['+91 98765 43210',      '+919876543210'],
    ['+91-9876-543210',      '+919876543210'],
    ['91-9876543210',        '+919876543210'],
    ['(+91) 9876543210',     '+919876543210'],
    ['  +919876543210  ',    '+919876543210'],   // outer whitespace
    ['+91.98765.43210',      '+919876543210'],   // dotted
    ['091-9876543210',       '+919876543210'],   // 091 prefix
    // Boundary: all four valid mobile prefixes (6/7/8/9).
    ['6876543210',           '+916876543210'],
    ['7876543210',           '+917876543210'],
    ['8876543210',           '+918876543210'],
  ];
  for (const [input, expected] of acceptCases) {
    eq(`[P1.1] normalisePhone(${JSON.stringify(input)})`, expected, normalisePhone(input));
  }

  // (P1.2) normalisePhone — spec §4.1 reject list
  const rejectCases: Array<[string, unknown]> = [
    ['5876543210',  '5 is not a valid Indian mobile prefix'],
    ['1234567890',  'starts with 1'],
    ['12345',       'too short'],
    ['98765432109', '11 digits'],
    ['',            'empty'],
    ['   ',         'whitespace-only'],
    ['abcdef',      'non-numeric'],
    ['+14155552671', 'US country code'],
    ['+447911123456', 'UK country code'],
    ['null',        'literal "null"'],
  ];
  for (const [input, why] of rejectCases) {
    eq(`[P1.2] normalisePhone(${JSON.stringify(input)}) → null (${why})`,
      null, normalisePhone(input));
  }
  // Non-string input.
  eq('[P1.2] normalisePhone(null) → null',      null, normalisePhone(null as unknown as string));
  eq('[P1.2] normalisePhone(undefined) → null', null, normalisePhone(undefined as unknown as string));
  eq('[P1.2] normalisePhone(123) → null',       null, normalisePhone(123 as unknown as string));

  // (P1.3) isValidIndianMobile
  assert('[P1.3] isValidIndianMobile("+919876543210") = true',  isValidIndianMobile('+919876543210'));
  assert('[P1.3] isValidIndianMobile("9876543210") = true (normalises in)',
    isValidIndianMobile('9876543210'));
  assert('[P1.3] isValidIndianMobile("+915876543210") = false', !isValidIndianMobile('+915876543210'));
  assert('[P1.3] isValidIndianMobile("") = false',              !isValidIndianMobile(''));

  // (P1.4) formatPhone — display-only
  eq('[P1.4] formatPhone("+919876543210")', '+91 98765 43210', formatPhone('+919876543210'));
  eq('[P1.4] formatPhone("")',              '',                formatPhone(''));
  eq('[P1.4] formatPhone(null)',            '',                formatPhone(null));
  eq('[P1.4] formatPhone(undefined)',       '',                formatPhone(undefined));
  // Defensive: invalid input echoes through unchanged.
  eq('[P1.4] formatPhone("not a phone")', 'not a phone', formatPhone('not a phone'));
  eq('[P1.4] formatPhone("+14155552671") echoes',
    '+14155552671', formatPhone('+14155552671'));

  // (P1.5) maskPhoneForDisplay
  eq('[P1.5] maskPhoneForDisplay("+919876543210")',
    '+91 ••••• ••3210', maskPhoneForDisplay('+919876543210'));
  eq('[P1.5] maskPhoneForDisplay("") = ""',                  '', maskPhoneForDisplay(''));
  eq('[P1.5] maskPhoneForDisplay(null) = ""',                '', maskPhoneForDisplay(null));
  eq('[P1.5] maskPhoneForDisplay("not a phone") echoes',
    'not a phone', maskPhoneForDisplay('not a phone'));

  // (P1.6) stripIndianPrefix — used by <PhoneField> for display derivation
  eq('[P1.6] stripIndianPrefix("+919876543210")', '9876543210', stripIndianPrefix('+919876543210'));
  eq('[P1.6] stripIndianPrefix("")',              '',           stripIndianPrefix(''));
  eq('[P1.6] stripIndianPrefix("9876543210")',    '9876543210', stripIndianPrefix('9876543210'));
  eq('[P1.6] stripIndianPrefix("+91987")',        '987',        stripIndianPrefix('+91987'));    // partial
  eq('[P1.6] stripIndianPrefix("+91 98765 43210") strips whitespace',
    '9876543210', stripIndianPrefix('+91 98765 43210'));
  eq('[P1.6] stripIndianPrefix(null)',            '',           stripIndianPrefix(null));
  // Defensive: cap at 10.
  eq('[P1.6] stripIndianPrefix caps at 10 digits',
    '9876543210', stripIndianPrefix('+91987654321099999'));
}

// ────────────────────────────────────────── 2. STATIC — file structure + audit

function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — file presence + no rogue inputs ──');

  // (P2.1) Component + utility exist.
  for (const p of [
    'src/components/forms/PhoneField.tsx',
    'src/lib/utils/phone.ts',
  ]) {
    assert(`[P2.1] file exists: ${p}`,
      existsSync(p) && statSync(p).isFile());
  }

  // (P2.2) One-and-only-one definition of `normalisePhone`.
  // The shared util OWNS it; phoneVerification.ts re-exports it; no
  // other file may declare a local `export function normalisePhone`.
  const ownerFile = 'src/lib/utils/phone.ts';
  const reExporter = 'src/lib/auth/phoneVerification.ts';
  const definers: string[] = [];
  function walk(root: string, fn: (p: string) => void): void {
    for (const name of readdirSync(root)) {
      const p = join(root, name).replace(/\\/g, '/');
      const s = statSync(p);
      if (s.isDirectory()) walk(p, fn);
      else fn(p);
    }
  }
  walk('src', (p) => {
    if (!/\.(ts|tsx)$/.test(p)) return;
    const src = readFileSync(p, 'utf-8');
    // Match a top-level definition, not a re-export.
    if (/^\s*export\s+function\s+normalisePhone\b/m.test(src)) definers.push(p);
  });
  assert(`[P2.2] single definition of normalisePhone (in ${ownerFile})`,
    definers.length === 1 && definers[0] === ownerFile,
    { definers });
  // The re-export site exists.
  assert(`[P2.2] ${reExporter} re-exports normalisePhone from the shared util`,
    /export\s*\{\s*normalisePhone[\s\S]*?\}\s*from\s*['"]@\/lib\/utils\/phone['"]/
      .test(readFileSync(reExporter, 'utf-8')));

  // (P2.3) Zero `type="tel"` inputs OUTSIDE the canonical PhoneField.
  // PhoneField itself is the one allowed site; everything else must
  // delegate to it.
  const ALLOW_TEL = new Set<string>([
    'src/components/forms/PhoneField.tsx',
  ]);
  const offenders: string[] = [];
  walk('src', (p) => {
    if (!/\.(ts|tsx)$/.test(p)) return;
    if (ALLOW_TEL.has(p)) return;
    const src = readFileSync(p, 'utf-8');
    // Strip comments so doc text like " type=\"tel\" " in a block
    // comment doesn't false-positive.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/type\s*=\s*["']tel["']/i.test(stripped)) offenders.push(p);
  });
  assert(`[P2.3] no rogue type="tel" inputs outside <PhoneField> (offenders: ${offenders.length})`,
    offenders.length === 0, { offenders });

  // (P2.4) Every API route file that has a `phone` field uses the
  // canonical `phoneSchema` import. Soft-audit: warn (don't fail) for
  // any phone field that bypasses it.
  const apiOffenders: string[] = [];
  walk('src/app/api', (p) => {
    if (!/\.ts$/.test(p)) return;
    const src = readFileSync(p, 'utf-8');
    // Heuristic: a phone Zod field is one where `phone:` is followed
    // by a Zod schema call (not by `phoneSchema` from our shared file).
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Match `phone: z.string()` BUT NOT `phone: phoneSchema` /
    // `phone: phoneSchema.optional()`.
    if (/\bphone\s*:\s*z\.string\s*\(\)/.test(stripped)) {
      apiOffenders.push(p);
    }
  });
  assert(`[P2.4] every API phone field uses the canonical phoneSchema (offenders: ${apiOffenders.length})`,
    apiOffenders.length === 0, { offenders: apiOffenders });

  // (P2.5) PhoneField is imported by every place we expect.
  const phoneFieldImporters = [
    'src/app/signup/page.tsx',
    'src/app/(storefront)/account/addresses/page.tsx',
    'src/app/(storefront)/checkout/page.tsx',
    'src/app/admin/(app)/store-config/page.tsx',
  ];
  for (const p of phoneFieldImporters) {
    const src = readFileSync(p, 'utf-8');
    assert(`[P2.5] ${p} imports PhoneField`,
      /from\s+['"]@\/components\/forms\/PhoneField['"]/.test(src));
  }

  // (P2.6) The schema marks store.supportPhone as fieldType: 'phone'.
  const schemaSrc = readFileSync('src/lib/storeConfig/schema.ts', 'utf-8');
  // The supportPhone entry's body has grown — widen the window and
  // anchor on the next entry key to avoid bleeding into siblings.
  const supportPhoneBlock = (schemaSrc
    .split(/^\s*['"]store\./m)
    .find((s) => s.startsWith('supportPhone'))) ?? '';
  assert(`[P2.6] store.supportPhone declares fieldType: 'phone'`,
    /fieldType\s*:\s*['"]phone['"]/.test(supportPhoneBlock),
    { firstChars: supportPhoneBlock.slice(0, 300) });
}

// ─────────────────── 3. INTEGRATION — spawn `next start`, hit live endpoints

async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JOB_RUNNER_ENABLED: 'false',
      // Item 9 integration covers the Zod-transform contract — we
      // don't need the storefront feature gates enforced here.
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

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
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
async function withCsrf(): Promise<Jar> {
  const jar = newJar();
  const r = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, r);
  return jar;
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

interface ApiResp { status: number; body: Record<string, unknown>; }
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
  return { status: res.status, body };
}

async function makeAdmin(): Promise<{ id: string; email: string }> {
  const email = `${TAG}_admin@shopcore.test`;
  const u = await prisma.user.create({
    data: {
      firstName: 'PF', lastName: 'Admin', email,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaPfAdmin'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new fixture admin (no prior state).
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return { id: u.id, email };
}

function uniquePhoneNational(): string {
  // Pick a leading 9 so the resulting +91 number is a valid Indian
  // mobile and unique per test run.
  return '9' + String(900_000_000 + Math.floor(Math.random() * 99_999_999)).slice(0, 9);
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — Zod transform normalises any input format ──');

  await startServer();

  // Helper for the verbose signup body (SignupSchema requires every
  // field including confirmPassword + country literal). We vary only
  // email + phone per assertion.
  function signupBody(label: string, phone: string): Record<string, unknown> {
    return {
      firstName: 'PF', lastName: label,
      email: `${TAG}_${label}@shopcore.test`,
      phone,
      password:        'Sm0kyM#7QrXaTest!',
      confirmPassword: 'Sm0kyM#7QrXaTest!',
      addressLine1: 'X', addressLine2: 'Y',
      city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
    };
  }

  // (P3.1) Signup with bare-10-digit phone → 200 → DB has +91XXXXXXXXXX.
  {
    const ten = uniquePhoneNational();
    const csrf = await withCsrf();
    const r = await call(csrf, '/api/auth/signup', { method: 'POST', json: signupBody('bare', ten) });
    eq('[P3.1] signup with bare digits → 200', 200, r.status);
    const dbUser = await prisma.user.findUnique({ where: { email: `${TAG}_bare@shopcore.test` } });
    eq(`[P3.1] DB phone = +91${ten}`, `+91${ten}`, dbUser?.phone);
  }

  // (P3.2) Signup with spaces in phone → 200 → normalised in DB.
  {
    const ten = uniquePhoneNational();
    const spaced = `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`;
    const csrf = await withCsrf();
    const r = await call(csrf, '/api/auth/signup', { method: 'POST', json: signupBody('spaced', spaced) });
    eq('[P3.2] signup with " +91 XXXXX XXXXX" → 200', 200, r.status);
    const dbUser = await prisma.user.findUnique({ where: { email: `${TAG}_spaced@shopcore.test` } });
    eq(`[P3.2] DB phone = +91${ten} (spaces stripped)`, `+91${ten}`, dbUser?.phone);
  }

  // (P3.3) Signup with "0" prefix → 200 → normalised in DB.
  {
    const ten = uniquePhoneNational();
    const csrf = await withCsrf();
    const r = await call(csrf, '/api/auth/signup', { method: 'POST', json: signupBody('zero', `0${ten}`) });
    eq('[P3.3] signup with "0XXXXXXXXXX" → 200', 200, r.status);
    const dbUser = await prisma.user.findUnique({ where: { email: `${TAG}_zero@shopcore.test` } });
    eq(`[P3.3] DB phone = +91${ten} (leading 0 stripped)`, `+91${ten}`, dbUser?.phone);
  }

  // (P3.4) Signup with invalid mobile prefix (5XXXXXXXXX) → 400.
  {
    const csrf = await withCsrf();
    const r = await call(csrf, '/api/auth/signup', { method: 'POST', json: signupBody('bad', '5876543210') });
    eq('[P3.4] signup with invalid mobile prefix → 400', 400, r.status);
    const dbUser = await prisma.user.findUnique({ where: { email: `${TAG}_bad@shopcore.test` } });
    assert('[P3.4] no DB user created on validation failure', dbUser === null);
  }

  // (P3.5) Admin store-config: PATCH supportPhone with bare digits →
  // normalised to E.164 in the persisted blob.
  {
    const admin   = await makeAdmin();
    const adminJar = await sessionJarFor(admin.id, 'ADMIN');
    const ten = uniquePhoneNational();
    const r = await call(adminJar, '/api/admin/store-config', { method: 'PATCH', json: {
      changes: { 'store.supportPhone': ten },
    }});
    eq('[P3.5] PATCH supportPhone with bare digits → 200', 200, r.status);
    const post = await call(adminJar, '/api/admin/store-config');
    const cfg = (post.body as { data: { config: { store: { supportPhone: string } } } })
      .data.config;
    eq(`[P3.5] store.supportPhone normalised to +91${ten}`,
      `+${'9'.length ? '91' : '91'}${ten}`,             // +91 + ten
      cfg.store.supportPhone);

    // And accept empty string (clearing the field).
    const r2 = await call(adminJar, '/api/admin/store-config', { method: 'PATCH', json: {
      changes: { 'store.supportPhone': '' },
    }});
    eq('[P3.5] PATCH supportPhone with "" → 200 (clear)', 200, r2.status);
    const post2 = await call(adminJar, '/api/admin/store-config');
    const cfg2 = (post2.body as { data: { config: { store: { supportPhone: string } } } })
      .data.config;
    eq('[P3.5] store.supportPhone cleared', '', cfg2.store.supportPhone);

    // And reject an invalid value (5-prefix).
    const r3 = await call(adminJar, '/api/admin/store-config', { method: 'PATCH', json: {
      changes: { 'store.supportPhone': '5876543210' },
    }});
    eq('[P3.5] PATCH supportPhone with invalid prefix → 400', 400, r3.status);
    eq('[P3.5] error code = CONFIG_VALIDATION_ERROR',
      'CONFIG_VALIDATION_ERROR', (r3.body as { code: string }).code);
  }

  // (P3.6) Address POST also normalises permissive phone formats.
  {
    const cust = await prisma.user.create({
      data: {
        firstName: 'Addr', lastName: 'Owner',
        email: `${TAG}_addr@shopcore.test`,
        phone: '+91' + uniquePhoneNational(),
        passwordHash: await hashPassword('Sm0kyM#7QrXaTest!'),
        addressLine1: 'X', addressLine2: 'Y',
        city: 'Mumbai', state: 'Maharashtra',
        pinCode: '400001', country: 'India',
        role: 'CUSTOMER',
        // STATE_MACHINE_BYPASS: brand-new fixture.
        status: 'ACTIVE', phoneVerified: true,
        referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
      },
    });
    const custJar = await sessionJarFor(cust.id, 'CUSTOMER');
    const ten = uniquePhoneNational();
    const r = await call(custJar, '/api/addresses', { method: 'POST', json: {
      fullName: 'Test User',
      phone: `+91-${ten.slice(0, 4)}-${ten.slice(4)}`,
      addressLine1: 'X', addressLine2: 'Y',
      city: 'Mumbai', state: 'Maharashtra', pinCode: '400001', country: 'India',
    }});
    eq('[P3.6] POST address with dashed phone → 200', 200, r.status);
    const addr = await prisma.address.findFirst({ where: { userId: cust.id } });
    eq(`[P3.6] address.phone normalised to +91${ten}`, `+91${ten}`, addr?.phone);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const RUN_INT = process.env.SHOPCORE_SKIP_INT !== '1';
  try {
    unitTests();
    staticAuditTests();
    if (RUN_INT) await integrationTests();
    else console.log('\n── INTEGRATION — SKIPPED (SHOPCORE_SKIP_INT=1) ──');
  } finally {
    await stopServer();
    // Cleanup fixtures.
    const users = await prisma.user.findMany({
      where: { email: { contains: 'pf_' } }, select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      await prisma.address.deleteMany({ where: { userId: { in: ids } } });
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.refreshTokenFamily.deleteMany({ where: { userId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.userActivity.deleteMany({ where: { userId: { in: ids } } });
      await prisma.otpCode.deleteMany({ where: { email: { contains: 'pf_' } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    // Restore supportPhone default (in case an integration test left a value).
    const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
    if (row) {
      try {
        const blob = JSON.parse(row.data) as Record<string, unknown>;
        const store = (blob.store ?? {}) as Record<string, unknown>;
        if (store.supportPhone !== undefined) {
          delete store.supportPhone;
          blob.store = store;
          await prisma.storeConfig.update({
            where: { id: 'singleton' },
            data:  { data: JSON.stringify(blob) },
          });
        }
      } catch { /* */ }
    }
    await prisma.$disconnect();
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
