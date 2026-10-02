/**
 * /contact + /support pages — Item 13. Test harness.
 *
 *   npm run test:contact-support
 *
 * Sections:
 *   1. UNIT     — ContactFormSchema accept/reject; honeypot field
 *                 parses; rate-limit policy entry; existence of every
 *                 new file.
 *   2. STATIC   — footer links updated; new components import from the
 *                 expected modules; no rogue window.alert/etc.
 *   3. INTEGRATION — spawn `next start`, exercise:
 *                 - GET /contact / /support → 200 (no more 404)
 *                 - POST /api/contact (valid → 200 + Job row)
 *                 - POST /api/contact (no CSRF → 403)
 *                 - POST /api/contact (honeypot → 200, NO Job)
 *                 - POST /api/contact (4× → 429 on the 4th)
 *                 - POST /api/contact (message < 20 → 400)
 *                 - /support with features.supportTickets=false/true
 *                 - /support with features.liveChat=false/true
 *                 - / homepage contains /contact + /support footer links
 *
 * Spec §4 — every assertion carries [C<n>.<m>] tags.
 */
// Pre-import side-effects.
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { ContactFormSchema, CONTACT_MESSAGE_MIN, CONTACT_MESSAGE_MAX } from '../src/lib/contact/schema';
import { RATE_LIMIT_POLICIES } from '../src/lib/security/rateLimitPolicies';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
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

const TAG = `cs_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const PORT = 3067;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-contact-support-${process.pid}.log`;

// ─────────────────────────────────────────────────────── 1. UNIT
function unitTests(): void {
  console.log('\n── UNIT — schema, policy, file presence ──');

  // (C1.1) ContactFormSchema accept
  {
    const r = ContactFormSchema.safeParse({
      name: 'Alice', email: 'a@b.com', subject: 'Hi', message: 'x'.repeat(CONTACT_MESSAGE_MIN),
    });
    assert('[C1.1] schema accepts a minimal valid body', r.success, r.success ? undefined : r.error.issues);
  }

  // (C1.2) Message too short → reject
  {
    const r = ContactFormSchema.safeParse({
      name: 'A', email: 'a@b.com', subject: 'Hi', message: 'x'.repeat(CONTACT_MESSAGE_MIN - 1),
    });
    assert('[C1.2] schema rejects message < min length', !r.success);
  }

  // (C1.3) Message > max → reject
  {
    const r = ContactFormSchema.safeParse({
      name: 'A', email: 'a@b.com', subject: 'Hi', message: 'x'.repeat(CONTACT_MESSAGE_MAX + 1),
    });
    assert('[C1.3] schema rejects message > max length', !r.success);
  }

  // (C1.4) Subject > 120 → reject
  {
    const r = ContactFormSchema.safeParse({
      name: 'A', email: 'a@b.com',
      subject: 'x'.repeat(121),
      message: 'x'.repeat(CONTACT_MESSAGE_MIN),
    });
    assert('[C1.4] schema rejects subject > 120 chars', !r.success);
  }

  // (C1.5) Invalid email → reject
  {
    const r = ContactFormSchema.safeParse({
      name: 'A', email: 'notanemail',
      subject: 'Hi', message: 'x'.repeat(CONTACT_MESSAGE_MIN),
    });
    assert('[C1.5] schema rejects invalid email', !r.success);
  }

  // (C1.6) Honeypot field parses (optional, max length enforced)
  {
    const r = ContactFormSchema.safeParse({
      name: 'A', email: 'a@b.com',
      subject: 'Hi', message: 'x'.repeat(CONTACT_MESSAGE_MIN),
      website: 'http://spam.com',
    });
    assert('[C1.6] schema parses honeypot value (acceptance only — handler discards)', r.success);
  }

  // (C1.7) Rate-limit policy `contact.form` exists with 3/hr/IP.
  {
    const p = (RATE_LIMIT_POLICIES as Record<string, unknown>)['contact.form'] as {
      keyStrategy: string; windows: Array<{ max: number; windowSec: number; label: string }>;
      skipInTest: boolean;
    } | undefined;
    assert('[C1.7] contact.form policy registered', p !== undefined);
    if (p) {
      eq('[C1.7] keyStrategy = ip',  'ip',  p.keyStrategy);
      eq('[C1.7] windows.length = 1', 1,    p.windows.length);
      eq('[C1.7] max = 3',           3,     p.windows[0].max);
      eq('[C1.7] window = 1h (3600s)', 3600, p.windows[0].windowSec);
      eq('[C1.7] skipInTest = false (integration asserts 429 path)', false, p.skipInTest);
    }
  }

  // (C1.8) Every new file exists.
  const required = [
    'src/app/(storefront)/contact/page.tsx',
    'src/app/(storefront)/support/page.tsx',
    'src/components/storefront/ContactForm.tsx',
    'src/components/storefront/FaqAccordion.tsx',
    'src/components/storefront/SupportTicketForm.tsx',
    'src/components/storefront/SupportTicketList.tsx',
    'src/app/api/contact/route.ts',
    'src/lib/contact/schema.ts',
  ];
  for (const p of required) {
    assert(`[C1.8] file exists: ${p}`, existsSync(p));
  }
}

// ────────────────────────────────────────── 2. STATIC AUDIT
function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — wiring & no rogue dialogs ──');

  // (C2.1) Footer carries both links.
  const footer = readFileSync('src/components/storefront/StorefrontFooter.tsx', 'utf-8');
  assert('[C2.1] StorefrontFooter links to /support', /href="\/support"/.test(footer));
  assert('[C2.1] StorefrontFooter links to /contact', /href="\/contact"/.test(footer));

  // (C2.2) Contact page imports getStoreConfig + ContactForm.
  const contact = readFileSync('src/app/(storefront)/contact/page.tsx', 'utf-8');
  assert('[C2.2] /contact page imports getStoreConfig',
    /from\s+['"]@\/lib\/storeConfig['"]/.test(contact));
  assert('[C2.2] /contact page imports ContactForm',
    /from\s+['"]@\/components\/storefront\/ContactForm['"]/.test(contact));
  assert('[C2.2] /contact page uses formatPhone',
    /formatPhone\(/.test(contact));
  assert('[C2.2] /contact page exports generateMetadata',
    /export\s+async\s+function\s+generateMetadata/.test(contact));

  // (C2.3) Support page imports the expected modules.
  const support = readFileSync('src/app/(storefront)/support/page.tsx', 'utf-8');
  assert('[C2.3] /support page imports FaqAccordion',
    /from\s+['"]@\/components\/storefront\/FaqAccordion['"]/.test(support));
  assert('[C2.3] /support page imports SupportTicketList',
    /from\s+['"]@\/components\/storefront\/SupportTicketList['"]/.test(support));
  assert('[C2.3] /support page exports generateMetadata',
    /export\s+async\s+function\s+generateMetadata/.test(support));
  assert('[C2.3] /support page guards live chat with features.liveChat',
    /features\.liveChat/.test(support));
  assert('[C2.3] /support page guards ticket section with features.supportTickets',
    /features\.supportTickets/.test(support));

  // (C2.4) /api/contact handler wiring.
  const apiRoute = readFileSync('src/app/api/contact/route.ts', 'utf-8');
  assert('[C2.4] /api/contact applies the contact.form rate limit',
    /applyRateLimit\(\s*['"]contact\.form['"]/.test(apiRoute));
  assert('[C2.4] /api/contact enqueues a SEND_EMAIL job',
    /enqueueJob\(\s*JOB_TYPES\.SEND_EMAIL/.test(apiRoute));
  // Widen the window — there's a logging line between the `if` and the
  // return. The audit just needs to confirm "honeypot path returns
  // jsonOk", not a specific shape.
  assert('[C2.4] /api/contact honeypot returns jsonOk for `website` non-empty',
    /body\.website[\s\S]{0,600}return\s+jsonOk/.test(apiRoute));

  // (C2.5) No window.alert / window.confirm / window.prompt anywhere
  // in the new components.
  for (const p of [
    'src/components/storefront/ContactForm.tsx',
    'src/components/storefront/FaqAccordion.tsx',
    'src/components/storefront/SupportTicketForm.tsx',
    'src/components/storefront/SupportTicketList.tsx',
  ]) {
    const src = readFileSync(p, 'utf-8');
    // Strip comments so doc references don't false-positive.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert(`[C2.5] no native window.{alert,confirm,prompt} in ${p}`,
      !/\bwindow\.(alert|confirm|prompt)\s*\(/.test(stripped));
  }
}

// ─────────────────── 3. INTEGRATION
async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JOB_RUNNER_ENABLED: 'false',
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

async function postContact(jar: Jar, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  headers.set('cookie', cookieHeader(jar));
  headers.set('content-type', 'application/json');
  if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  headers.set('origin', BASE);
  const res = await fetch(`${BASE}/api/contact`, { method: 'POST', headers, body: JSON.stringify(body) });
  applySetCookies(jar, res);
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body: parsed };
}

/** Build a CSRF-armed admin session jar against the spawned child.
 *  Used by withStoreConfig to PATCH via the admin endpoint so the
 *  child's 30-second in-process config cache is invalidated atomically
 *  on every change — no 30s sleeps. */
async function adminJarFor(adminId: string): Promise<Jar> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  const fam = await issueRefreshFamily({ userId: adminId, role: 'ADMIN' });
  const ttl = accessTtlFor('ADMIN');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: u.id, role: u.role, email: u.email,
    jti: sessionId, fam: fam.familyId, status: u.status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId: adminId, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, csrfRes);
  jar.cookies['sc_admin']         = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return jar;
}

let _testAdminId: string | null = null;
async function getOrCreateTestAdmin(): Promise<string> {
  if (_testAdminId) return _testAdminId;
  const u = await prisma.user.create({
    data: {
      firstName: 'CS', lastName: 'Admin',
      email: `${TAG}_admin_account@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestCS'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new fixture admin.
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  _testAdminId = u.id;
  return u.id;
}

/**
 * Set config keys via the admin PATCH endpoint, which atomically
 * invalidates the child server's in-process cache. Far faster than
 * waiting for the 30s TTL. Returns a function that PATCHes the
 * settings back to their original values.
 */
async function withStoreConfig(flatChanges: Record<string, unknown>): Promise<() => Promise<void>> {
  const adminId = await getOrCreateTestAdmin();
  const jar     = await adminJarFor(adminId);

  // Snapshot the original values via GET.
  const getHeaders = new Headers();
  getHeaders.set('cookie', cookieHeader(jar));
  const getRes = await fetch(`${BASE}/api/admin/store-config`, { headers: getHeaders });
  const getBody = await getRes.json() as { data: { config: Record<string, unknown> } };
  const cfg = getBody.data.config;
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(flatChanges)) {
    const [head, leaf] = key.split('.');
    const cat = cfg[head] as Record<string, unknown> | undefined;
    original[key] = cat?.[leaf];
  }

  // PATCH the new values.
  const patchHeaders = new Headers();
  patchHeaders.set('cookie', cookieHeader(jar));
  patchHeaders.set('content-type', 'application/json');
  if (jar.cookies['sc_csrf']) patchHeaders.set('x-csrf-token', jar.cookies['sc_csrf']);
  patchHeaders.set('origin', BASE);
  const patchRes = await fetch(`${BASE}/api/admin/store-config`, {
    method: 'PATCH', headers: patchHeaders,
    body: JSON.stringify({ changes: flatChanges }),
  });
  if (patchRes.status !== 200) {
    const txt = await patchRes.text();
    throw new Error(`withStoreConfig PATCH failed (${patchRes.status}): ${txt.slice(0, 200)}`);
  }

  return async () => {
    const restoreHeaders = new Headers();
    restoreHeaders.set('cookie', cookieHeader(jar));
    restoreHeaders.set('content-type', 'application/json');
    if (jar.cookies['sc_csrf']) restoreHeaders.set('x-csrf-token', jar.cookies['sc_csrf']);
    restoreHeaders.set('origin', BASE);
    await fetch(`${BASE}/api/admin/store-config`, {
      method: 'PATCH', headers: restoreHeaders,
      body: JSON.stringify({ changes: original }),
    });
  };
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — /contact, /support, /api/contact ──');

  await startServer();

  // Make sure notifications.adminEmail is populated for the duration
  // of the integration tests; otherwise /api/contact returns 503. The
  // PATCH-via-admin-endpoint approach atomically invalidates the
  // child's in-process cache — no 30s sleeps needed.
  const restoreAdmin = await withStoreConfig({
    'notifications.adminEmail': `${TAG}_admin@shopcore.test`,
  });

  // (C3.1) GET /contact → 200 (no more 404).
  {
    const res = await fetch(`${BASE}/contact`);
    eq('[C3.1] GET /contact → 200', 200, res.status);
    const html = await res.text();
    assert('[C3.1] page HTML mentions the store name', /ShopCore/.test(html));
    assert('[C3.1] page HTML includes the contact form (Send message button)',
      /Send message/.test(html));
  }

  // (C3.2) GET /support → 200.
  {
    const res = await fetch(`${BASE}/support`);
    eq('[C3.2] GET /support → 200', 200, res.status);
    const html = await res.text();
    assert('[C3.2] /support page mentions "How can we help?"',
      /How can we help/.test(html));
    assert('[C3.2] /support page renders the FAQ heading',
      /Frequently asked questions/i.test(html));
    // Anonymous user → sign-in prompt (features.supportTickets defaults to true).
    assert('[C3.2] anonymous /support shows sign-in prompt for tickets',
      /Track your support tickets/i.test(html));
  }

  // (C3.3) Homepage footer carries both links.
  {
    const res = await fetch(`${BASE}/`);
    eq('[C3.3] GET / → 200', 200, res.status);
    const html = await res.text();
    assert('[C3.3] homepage HTML links to /contact in the footer',
      /href="\/contact"/.test(html));
    assert('[C3.3] homepage HTML links to /support in the footer',
      /href="\/support"/.test(html));
  }

  // ── Contact form flows ────────────────────────────────────────────

  // (C3.4) POST /api/contact valid → 200 + Job enqueued.
  {
    const csrf = await withCsrf();
    const before = await prisma.job.count({ where: { type: 'send_email' } });
    const r = await postContact(csrf, {
      name:    `${TAG} Tester`,
      email:   `${TAG}_tester@example.com`,
      subject: `Hello from test ${TAG}`,
      message: 'This is a perfectly normal contact-form submission for the integration suite.',
    });
    eq('[C3.4] POST /api/contact valid → 200', 200, r.status);
    const after = await prisma.job.count({ where: { type: 'send_email' } });
    assert(`[C3.4] SEND_EMAIL Job row created (before=${before}, after=${after})`,
      after === before + 1);
    // Verify the most recent job's payload addresses our test admin.
    const lastJob = await prisma.job.findFirst({
      where: { type: 'send_email' }, orderBy: { createdAt: 'desc' },
    });
    const payload = lastJob ? JSON.parse(lastJob.payload) as { to: string; subject: string } : null;
    assert('[C3.4] Job payload `to` = configured admin email',
      payload?.to === `${TAG}_admin@shopcore.test`,
      { actual: payload?.to });
    assert(`[C3.4] Job payload subject is prefixed with "[ShopCore Contact]"`,
      typeof payload?.subject === 'string' && payload.subject.startsWith('[ShopCore Contact]'),
      { subject: payload?.subject });
  }

  // (C3.5) Honeypot → 200, NO Job created.
  {
    const csrf = await withCsrf();
    const before = await prisma.job.count({ where: { type: 'send_email' } });
    const r = await postContact(csrf, {
      name:    `${TAG} Bot`,
      email:   `${TAG}_bot@example.com`,
      subject: 'Buy cheap watches',
      message: 'BUY CHEAP WATCHES BUY CHEAP WATCHES BUY CHEAP WATCHES',
      website: 'http://spam.example.com',
    });
    eq('[C3.5] honeypot → 200 (silent reject)', 200, r.status);
    const after = await prisma.job.count({ where: { type: 'send_email' } });
    eq('[C3.5] no Job enqueued for honeypot trigger', before, after);
  }

  // (C3.6) Missing CSRF → 403.
  {
    const res = await fetch(`${BASE}/api/contact`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body:    JSON.stringify({
        name: 'A', email: 'a@b.com', subject: 'Hi',
        message: 'A message that is at least twenty characters.',
      }),
    });
    eq('[C3.6] POST /api/contact without CSRF → 403', 403, res.status);
  }

  // (C3.7) Validation — message < 20 chars → 400.
  {
    const csrf = await withCsrf();
    const r = await postContact(csrf, {
      name: 'A', email: 'a@b.com', subject: 'Hi', message: 'short',
    });
    eq('[C3.7] short message → 400', 400, r.status);
    eq('[C3.7] error code = VALIDATION_ERROR',
      'VALIDATION_ERROR', (r.body as { code?: string }).code);
  }

  // (C3.8) Rate limit — 4× rapid requests → 4th gets 429.
  // The earlier valid submission already counted as 1 against the IP
  // bucket; honeypot counts too (we still apply the limit before the
  // honeypot check). So a single fresh test would be tricky to bound.
  // We deliberately submit 3 MORE valid requests from this point: the
  // 4th in the window across the whole IP must trip 429.
  {
    let last429 = false;
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const csrf = await withCsrf();
      const r = await postContact(csrf, {
        name: `${TAG} RL${i}`,
        email: `${TAG}_rl${i}@example.com`,
        subject: 'Rate limit test ' + i,
        message: 'Just exercising the contact form rate limiter for the integration suite.',
      });
      lastStatus = r.status;
      if (r.status === 429) { last429 = true; break; }
    }
    assert(`[C3.8] rapid contact submissions hit 429 (last=${lastStatus})`, last429);
  }

  // (C3.9) Feature flag: features.supportTickets = false → section removed.
  // The PATCH path invalidates the child's in-process cache
  // atomically — no sleep needed.
  {
    const restore = await withStoreConfig({ 'features.supportTickets': false });
    const res = await fetch(`${BASE}/support`);
    const html = await res.text();
    assert('[C3.9] features.supportTickets=false → "My support tickets" heading absent',
      !/My support tickets/i.test(html)
      // Also no anon-prompt heading (the whole section is removed).
      && !/Track your support tickets/i.test(html),
      { excerpt: html.match(/.{0,40}upport.{0,40}/g)?.slice(0, 5) });
    await restore();
  }

  // (C3.10) Feature flag: features.liveChat = true → live chat card present.
  {
    const restore = await withStoreConfig({ 'features.liveChat': true });
    const res = await fetch(`${BASE}/support`);
    const html = await res.text();
    assert('[C3.10] features.liveChat=true → "Chat with us" card present',
      /Chat with us/.test(html));
    await restore();
  }

  // (C3.11) Feature flag: features.liveChat = false → card absent from DOM.
  {
    const restore = await withStoreConfig({ 'features.liveChat': false });
    const res = await fetch(`${BASE}/support`);
    const html = await res.text();
    assert('[C3.11] features.liveChat=false → "Chat with us" card absent',
      !/Chat with us/.test(html),
      { excerpt: html.match(/.{0,30}hat.{0,30}/g)?.slice(0, 5) });
    await restore();
  }

  await restoreAdmin();
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
    // Cleanup any Jobs / Tickets we created.
    await prisma.job.deleteMany({ where: { payload: { contains: TAG } } });
    await prisma.supportTicket.deleteMany({
      where: { subject: { contains: TAG } },
    });
    // Test admin + its sessions / audit rows.
    const admins = await prisma.user.findMany({
      where: { email: { contains: 'cs_' } }, select: { id: true },
    });
    const ids = admins.map((u) => u.id);
    if (ids.length > 0) {
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
