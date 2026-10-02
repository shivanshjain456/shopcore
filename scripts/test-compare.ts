/**
 * Compare feature — Item 14. Test harness.
 *
 *   npm run test:compare
 *
 * Sections:
 *   1. UNIT          — attribute groups; union-of-keys; difference
 *                      detection; isEqualValue; compareData parse.
 *   2. STATIC AUDIT  — required files present; no leaked legacy
 *                      window.alert/confirm in compare components;
 *                      compare findMany() calls are take-bounded or
 *                      PAGINATION-EXEMPT; CompareTable reuses the
 *                      shared button components.
 *   3. INTEGRATION   — spawn `next start` on port 3071; exercise
 *                      every endpoint (GET / POST / DELETE / sync /
 *                      share-URL) + the feature-flag gate +
 *                      cookie-backed anonymous path.
 *
 * Spec §4 — every assertion carries [CMP<n>.<m>] tags.
 */
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
import {
  getAttributeGroupsForCategory,
  getAttributeGroupsForCategories,
  UNIVERSAL_GROUPS,
  CATEGORY_GROUPS,
} from '../src/lib/compare/attributeGroups';
import {
  parseAttributes, unionAttributeKeys, leftoverAttributeKeys,
} from '../src/lib/compare/attributeKeyResolver';
import {
  normaliseForCompare, isEqualValue, detectDifference,
} from '../src/lib/compare/differenceDetector';
import { COMPARE_HARD_CAP } from '../src/lib/account/compare';
import { RATE_LIMIT_POLICIES } from '../src/lib/security/rateLimitPolicies';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  if (existsSync(SRV_LOG)) {
    const tail = readFileSync(SRV_LOG, 'utf-8').split('\n').slice(-20).join('\n');
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

const TAG = `cmp_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
/** Slug-safe variant of TAG — only [a-z0-9-]+ so it passes the
 *  share-URL validator (`/compare?products=…`). */
const TAG_SLUG = `cmp-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const PORT = 3071;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-compare-${process.pid}.log`;

// ── 1. UNIT ──────────────────────────────────────────────────────────────

function unitTests(): void {
  console.log('\n── UNIT — attribute groups, union, diff detector ──');

  // (CMP1.1) Universal groups always include overview / pricing / availability.
  {
    const ids = UNIVERSAL_GROUPS.map((g) => g.id);
    assert('[CMP1.1] universal groups include "overview"',     ids.includes('overview'));
    assert('[CMP1.1] universal groups include "pricing"',      ids.includes('pricing'));
    assert('[CMP1.1] universal groups include "ratings"',      ids.includes('ratings'));
    assert('[CMP1.1] universal groups include "availability"', ids.includes('availability'));
  }

  // (CMP1.2) Category-specific groups for known categories.
  {
    const laptopGroups = getAttributeGroupsForCategory('laptops');
    const laptopIds    = laptopGroups.map((g) => g.id);
    assert('[CMP1.2] laptops include the "display" group',     laptopIds.includes('display'));
    assert('[CMP1.2] laptops include the "performance" group', laptopIds.includes('performance'));
    assert('[CMP1.2] laptops include the "connectivity" group',laptopIds.includes('connectivity'));
    assert('[CMP1.2] laptops include the "physical" group',    laptopIds.includes('physical'));
  }

  // (CMP1.3) Universal groups always prefix category groups.
  {
    const groups = getAttributeGroupsForCategory('laptops');
    eq('[CMP1.3] first group is the universal "overview"', 'overview', groups[0].id);
  }

  // (CMP1.4) Unknown category returns only universal groups.
  {
    const groups = getAttributeGroupsForCategory('made-up-category-12345');
    eq('[CMP1.4] unknown category → universal only',
      UNIVERSAL_GROUPS.length, groups.length);
  }

  // (CMP1.5) Null/undefined category returns universal only.
  {
    eq('[CMP1.5] null category → universal only',
      UNIVERSAL_GROUPS.length,
      getAttributeGroupsForCategory(null).length);
    eq('[CMP1.5] undefined category → universal only',
      UNIVERSAL_GROUPS.length,
      getAttributeGroupsForCategory(undefined).length);
  }

  // (CMP1.6) Multi-category union de-duplicates by id.
  {
    const groups = getAttributeGroupsForCategories(['laptops', 'laptops', 'processors']);
    const ids    = groups.map((g) => g.id);
    eq('[CMP1.6] no duplicate group ids in union',
      ids.length, new Set(ids).size);
    // 'physical' appears in both laptops + accessories but we only added
    // laptops + processors here; processors do NOT have 'physical'.
    assert('[CMP1.6] laptops "display" present',     ids.includes('display'));
    assert('[CMP1.6] processors "architecture" present', ids.includes('architecture'));
  }

  // (CMP1.7) parseAttributes is defensive.
  {
    eq('[CMP1.7] null  → {}',         {}, parseAttributes(null));
    eq('[CMP1.7] undefined → {}',     {}, parseAttributes(undefined));
    eq('[CMP1.7] ""    → {}',         {}, parseAttributes(''));
    eq('[CMP1.7] "[]"  → {}',         {}, parseAttributes('[]'));    // arrays rejected
    eq('[CMP1.7] "abc" → {}',         {}, parseAttributes('abc'));   // bad JSON
    eq('[CMP1.7] valid JSON parsed', { processor: 'Ryzen' }, parseAttributes('{"processor":"Ryzen"}'));
  }

  // (CMP1.8) Union of keys preserves first-seen order.
  {
    const a = { processor: 'X', ram: '16G' };
    const b = { processor: 'Y', storage: '1T' };
    const c = { gpu: 'Z' };
    const keys = unionAttributeKeys([a, b, c]);
    eq('[CMP1.8] order = first-seen',
      ['processor', 'ram', 'storage', 'gpu'], keys);
  }

  // (CMP1.9) Union with empty attrs.
  {
    const keys = unionAttributeKeys([{ a: 1 }, {}]);
    eq('[CMP1.9] empty attrs contribute nothing', ['a'], keys);
  }

  // (CMP1.10) Leftover-keys algorithm.
  {
    const leftover = leftoverAttributeKeys(['a', 'b', 'c'], ['b']);
    eq('[CMP1.10] removes covered keys', ['a', 'c'], leftover);
  }

  // (CMP1.11) normaliseForCompare.
  {
    eq('[CMP1.11] null  → ""',  '',         normaliseForCompare(null));
    eq('[CMP1.11] undef → ""',  '',         normaliseForCompare(undefined));
    eq('[CMP1.11] "AMD"→ amd',  'amd',      normaliseForCompare('AMD'));
    eq('[CMP1.11] " 1.5 " → "1.5"', '1.5',  normaliseForCompare(' 1.5 '));
    eq('[CMP1.11] 1.5 → "1.5"',     '1.5',  normaliseForCompare(1.5));
    eq('[CMP1.11] true → "true"',   'true', normaliseForCompare(true));
    eq('[CMP1.11] array joins with |',
      'a|b|c', normaliseForCompare(['A', 'B', 'C']));
  }

  // (CMP1.12) isEqualValue handles common gotchas.
  {
    assert('[CMP1.12] AMD == amd',          isEqualValue('AMD', 'amd'));
    assert('[CMP1.12] "1.5" == 1.5',        isEqualValue('1.5', 1.5));
    assert('[CMP1.12] null == null',        isEqualValue(null, null));
    assert('[CMP1.12] null != "x"',         !isEqualValue(null, 'x'));
    assert('[CMP1.12] arr eq',              isEqualValue(['A','B'], ['a','b']));
  }

  // (CMP1.13) detectDifference.
  {
    assert('[CMP1.13] [x,x,x] no diff',         !detectDifference(['x', 'x', 'x']));
    assert('[CMP1.13] [x,y] diff',              detectDifference(['x', 'y']));
    assert('[CMP1.13] [AMD,amd] no diff',       !detectDifference(['AMD', 'amd']));
    assert('[CMP1.13] [1.5kg, null] diff',      detectDifference(['1.5kg', null]));
    assert('[CMP1.13] all-empties → no diff',   !detectDifference([null, '', undefined]));
    assert('[CMP1.13] [x] singleton → no diff', !detectDifference(['x']));
    assert('[CMP1.13] 3-way diff: one odd one out',
      detectDifference(['x', 'x', 'y']));
  }

  // (CMP1.14) COMPARE_HARD_CAP is fixed at 4 and the rate-limit
  //           policies are registered.
  {
    eq('[CMP1.14] COMPARE_HARD_CAP = 4', 4, COMPARE_HARD_CAP);
    const policies = RATE_LIMIT_POLICIES as Record<string, unknown>;
    assert('[CMP1.14] compare.add policy registered',  policies['compare.add']  !== undefined);
    assert('[CMP1.14] compare.sync policy registered', policies['compare.sync'] !== undefined);
  }

  // (CMP1.15) Processors category has the spec-image attribute groups.
  {
    const groups = CATEGORY_GROUPS.processors;
    const ids    = groups.map((g) => g.id);
    assert('[CMP1.15] processors include "physical_properties"', ids.includes('physical_properties'));
    assert('[CMP1.15] processors include "architecture"',        ids.includes('architecture'));
    assert('[CMP1.15] processors include "cores"',               ids.includes('cores'));
  }
}

// ── 2. STATIC AUDIT ──────────────────────────────────────────────────────

function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — files, reuse, no rogue dialogs ──');

  // (CMP2.1) Required new files present.
  const required = [
    'src/lib/compare/attributeGroups.ts',
    'src/lib/compare/attributeKeyResolver.ts',
    'src/lib/compare/differenceDetector.ts',
    'src/lib/compare/compareData.ts',
    'src/lib/account/compare.ts',
    'src/app/api/compare/route.ts',
    'src/app/api/compare/[productId]/route.ts',
    'src/app/api/compare/sync/route.ts',
    'src/components/storefront/CompareProvider.tsx',
    'src/components/storefront/CompareTray.tsx',
    'src/components/storefront/CompareButton.tsx',
    'src/components/storefront/CompareTable.tsx',
    'src/components/storefront/CompareProductHeader.tsx',
    'src/components/storefront/CompareActionRow.tsx',
    'src/components/storefront/CompareRatingBreakdown.tsx',
    'src/components/storefront/CompareVariantsTable.tsx',
    'src/components/storefront/CompareAttributeRow.tsx',
    'src/app/(storefront)/compare/page.tsx',
    'src/app/(storefront)/compare/CompareClient.tsx',
  ];
  for (const p of required) assert(`[CMP2.1] file exists: ${p}`, existsSync(p));

  // (CMP2.2) Action row reuses the shared button components.
  {
    const src = readFileSync('src/components/storefront/CompareActionRow.tsx', 'utf-8');
    assert('[CMP2.2] CompareActionRow imports AddToCartButton',  /from\s+['"]\.\/AddToCartButton['"]/.test(src));
    assert('[CMP2.2] CompareActionRow imports BuyNowButton',     /from\s+['"]\.\/BuyNowButton['"]/.test(src));
    assert('[CMP2.2] CompareActionRow imports WishlistButton',   /from\s+['"]\.\/WishlistButton['"]/.test(src));
  }

  // (CMP2.3) No native window.alert/confirm/prompt anywhere in the
  //          compare components.
  for (const p of [
    'src/components/storefront/CompareButton.tsx',
    'src/components/storefront/CompareTray.tsx',
    'src/components/storefront/CompareTable.tsx',
    'src/app/(storefront)/compare/CompareClient.tsx',
  ]) {
    const src = readFileSync(p, 'utf-8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert(`[CMP2.3] no native dialogs in ${p}`,
      !/\bwindow\.(alert|confirm|prompt)\s*\(/.test(stripped));
  }

  // (CMP2.4) Compare API findMany() calls are take-bounded or marked
  //          PAGINATION-EXEMPT.
  for (const p of [
    'src/app/api/compare/route.ts',
    'src/app/api/compare/[productId]/route.ts',
    'src/app/api/compare/sync/route.ts',
    'src/lib/account/compare.ts',
    'src/lib/compare/compareData.ts',
  ]) {
    const raw = readFileSync(p, 'utf-8');
    const rawLines = raw.split('\n');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const lines = stripped.split('\n');
    let offenders = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/findMany\s*\(/.test(lines[i])) continue;
      const start = Math.max(0, i - 4);
      const end   = Math.min(lines.length, i + 25);
      const win    = lines.slice(start, end).join('\n');
      const rawWin = rawLines.slice(start, end).join('\n');
      if (/\btake\s*:/.test(win))                       continue;
      if (/[,{(\s]take\s*[,}\n]/.test(win))             continue;
      if (/PAGINATION-EXEMPT/.test(rawWin))             continue;
      offenders++;
    }
    eq(`[CMP2.4] ${p} unbounded findMany count = 0`, 0, offenders);
  }

  // (CMP2.5) CompareTray hides itself on /compare via usePathname check.
  {
    const src = readFileSync('src/components/storefront/CompareTray.tsx', 'utf-8');
    assert('[CMP2.5] CompareTray short-circuits on /compare path',
      /pathname\s*===\s*['"]\/compare['"]/.test(src));
  }

  // (CMP2.6) /compare page is gated by features.compareEnabled.
  {
    const src = readFileSync('src/app/(storefront)/compare/page.tsx', 'utf-8');
    assert('[CMP2.6] /compare page calls isFeatureOn("features.compareEnabled")',
      /features\.compareEnabled/.test(src));
    assert('[CMP2.6] /compare page returns notFound when disabled',
      /notFound\(\)/.test(src));
  }

  // (CMP2.7) Storefront layout mounts CompareProvider + CompareTray.
  {
    const src = readFileSync('src/app/(storefront)/layout.tsx', 'utf-8');
    assert('[CMP2.7] storefront layout wraps with <CompareProvider>',
      /<CompareProvider>/.test(src));
    assert('[CMP2.7] storefront layout renders <CompareTray />',
      /<CompareTray\s*\/?>/.test(src));
  }
}

// ── 3. INTEGRATION ───────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JOB_RUNNER_ENABLED: 'false',
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

async function withCsrf(jar?: Jar): Promise<Jar> {
  const j = jar ?? newJar();
  const r = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(j) } });
  applySetCookies(j, r);
  return j;
}

async function getJson(path: string, jar?: Jar): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (jar) headers.set('cookie', cookieHeader(jar));
  const res = await fetch(`${BASE}${path}`, { headers });
  applySetCookies(jar ?? newJar(), res);
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body: parsed };
}

async function mutate(
  jar: Jar, path: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  headers.set('cookie', cookieHeader(jar));
  headers.set('content-type', 'application/json');
  if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  headers.set('origin', BASE);
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  applySetCookies(jar, res);
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body: parsed };
}

async function userJarFor(userId: string): Promise<Jar> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  // Prisma returns u.role as a Prisma enum string; cast for refresh helpers.
  const role = u.role as unknown as Parameters<typeof issueRefreshFamily>[0]['role'];
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
  const jar = await withCsrf();
  jar.cookies['sc_session'] = jwt;
  jar.cookies['sc_session_refresh'] = fam.secret;
  return jar;
}

// ── Admin helpers — used by the feature-flag test ────────────────────────

let _testAdminId: string | null = null;
async function getOrCreateTestAdmin(): Promise<string> {
  if (_testAdminId) return _testAdminId;
  const u = await prisma.user.create({
    data: {
      firstName: 'CMP', lastName: 'Admin',
      email: `${TAG}_admin@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestCMP'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new fixture admin.
      status: 'ACTIVE', phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  _testAdminId = u.id;
  return u.id;
}

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
  const jar = await withCsrf();
  jar.cookies['sc_admin']         = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return jar;
}

/**
 * Atomically PATCH store-config keys via the admin endpoint so the
 * spawned child server's 30-second in-process cache is invalidated.
 * Returns a teardown function that restores the original values.
 */
async function withStoreConfig(flatChanges: Record<string, unknown>): Promise<() => Promise<void>> {
  const adminId = await getOrCreateTestAdmin();
  const jar     = await adminJarFor(adminId);

  // Snapshot original values via GET.
  const getRes = await fetch(`${BASE}/api/admin/store-config`, { headers: { cookie: cookieHeader(jar) } });
  const getBody = await getRes.json() as { data: { config: Record<string, unknown> } };
  const cfg = getBody.data.config;
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(flatChanges)) {
    const [head, leaf] = key.split('.');
    const cat = cfg[head] as Record<string, unknown> | undefined;
    original[key] = cat?.[leaf];
  }

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

// ── Fixtures ─────────────────────────────────────────────────────────────

interface ProductFixture { id: string; slug: string; categorySlug: string }

async function createFixtureProducts(): Promise<ProductFixture[]> {
  // Re-use existing category or make a new one.
  // Names are unique too — TAG-suffix them so leftover rows from a
  // prior failed run don't trip a P2002 here.
  const cat = await prisma.category.upsert({
    where:  { slug: `${TAG_SLUG}-laptops` },
    update: {},
    create: { name: `Test Laptops ${TAG_SLUG}`,  slug: `${TAG_SLUG}-laptops`, sortOrder: 999, isActive: true },
  });
  const brand = await prisma.brand.upsert({
    where:  { slug: `${TAG_SLUG}-brand` },
    update: {},
    create: { name: `TestBrand ${TAG_SLUG}`, slug: `${TAG_SLUG}-brand`, isActive: true },
  });

  const attrA = {
    processor: 'Intel i5',
    ram:       '16GB',
    storage:   '512GB SSD',
    color:     'Silver',
  };
  const attrB = {
    processor: 'Intel i7',     // diff
    ram:       '16GB',         // same
    storage:   '1TB SSD',      // diff
    weight:    '1.2kg',        // only on B
  };
  const products: ProductFixture[] = [];
  for (const [i, attrs] of [attrA, attrB].entries()) {
    const p = await prisma.product.create({
      data: {
        sku:         `${TAG}-SKU-${i}`,
        name:        `Test Laptop ${i}`,
        slug:        `${TAG_SLUG}-laptop-${i}`,
        description: 'fixture',
        shortDesc:   'fixture',
        categoryId:  cat.id,
        brandId:     brand.id,
        mrpPaise:    100_000 * 100,
        pricePaise:   80_000 * 100,
        gstRate:     18,
        hsnCode:     '8471',
        stock:       10,
        attributes:  JSON.stringify(attrs),
        isActive:    true,
      },
    });
    products.push({ id: p.id, slug: p.slug, categorySlug: cat.slug });
  }
  // A third product, inactive, to test invalid-product handling.
  await prisma.product.create({
    data: {
      sku:        `${TAG}-INACTIVE`,
      name:       'Inactive Laptop',
      slug:       `${TAG_SLUG}-laptop-inactive`,
      description:'fixture', categoryId: cat.id, brandId: brand.id,
      mrpPaise: 1, pricePaise: 1, gstRate: 0,
      stock: 0, attributes: '{}', isActive: false,
    },
  });
  return products;
}

async function createTestUser(): Promise<string> {
  const u = await prisma.user.create({
    data: {
      firstName: 'CMP', lastName: 'User',
      email: `${TAG}_user@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestCMP'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'CUSTOMER',
      // STATE_MACHINE_BYPASS: brand-new fixture customer.
      status: 'ACTIVE', phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return u.id;
}

interface Envelope {
  ok?:   boolean;
  data?: { items?: unknown[]; maxItems?: number };
  error?: string;
  code?:  string;
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — endpoints, share URL, feature flag ──');

  await startServer();
  try {
    const productsFx = await createFixtureProducts();
    const slugA = productsFx[0].slug;
    const slugB = productsFx[1].slug;
    const idA   = productsFx[0].id;
    const idB   = productsFx[1].id;

    // (CMP3.1) Anonymous GET returns empty.
    {
      const jar = newJar();
      const r   = await getJson('/api/compare', jar);
      eq('[CMP3.1] anonymous GET /api/compare status', 200, r.status);
      const env = r.body as Envelope;
      eq('[CMP3.1] anonymous compare empty', 0, (env.data?.items ?? []).length);
      eq('[CMP3.1] maxItems = 4', 4, env.data?.maxItems);
    }

    // (CMP3.2) Anonymous POST adds via cookie path.
    {
      const jar = await withCsrf();
      const r1  = await mutate(jar, '/api/compare', 'POST', { productId: idA });
      eq('[CMP3.2] anonymous POST status', 200, r1.status);
      const env1 = r1.body as Envelope;
      eq('[CMP3.2] list now contains one item', 1, (env1.data?.items ?? []).length);
      // GET reads the updated cookie.
      const r2  = await getJson('/api/compare', jar);
      const env2 = r2.body as Envelope;
      eq('[CMP3.2] subsequent GET reflects cookie', 1, (env2.data?.items ?? []).length);
      // Cookie was set on the response.
      assert('[CMP3.2] sc_compare_v1 cookie was set', jar.cookies['sc_compare_v1'] !== undefined);
    }

    // (CMP3.3) POST with unknown productId → 400 + COMPARE_INVALID_PRODUCT.
    {
      const jar = await withCsrf();
      const r = await mutate(jar, '/api/compare', 'POST', { productId: 'nonexistent_id_xyz' });
      eq('[CMP3.3] unknown productId status 400', 400, r.status);
      const env = r.body as Envelope;
      eq('[CMP3.3] error code = COMPARE_INVALID_PRODUCT', 'COMPARE_INVALID_PRODUCT', env.code);
    }

    // (CMP3.4) POST with inactive productId → 400 + COMPARE_INVALID_PRODUCT.
    {
      const inactive = await prisma.product.findUnique({ where: { slug: `${TAG_SLUG}-laptop-inactive` }, select: { id: true } });
      const jar = await withCsrf();
      const r = await mutate(jar, '/api/compare', 'POST', { productId: inactive!.id });
      eq('[CMP3.4] inactive product status 400', 400, r.status);
      const env = r.body as Envelope;
      eq('[CMP3.4] error code = COMPARE_INVALID_PRODUCT', 'COMPARE_INVALID_PRODUCT', env.code);
    }

    // (CMP3.5) Authenticated GET/POST uses DB path.
    const userId = await createTestUser();
    const userJar = await userJarFor(userId);
    {
      const before = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.5] authed user starts with 0 server-side rows', 0, before);
      const r = await mutate(userJar, '/api/compare', 'POST', { productId: idA });
      eq('[CMP3.5] authed POST status', 200, r.status);
      const after = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.5] one CompareItem row was inserted', 1, after);
    }

    // (CMP3.6) Re-POST same product is idempotent.
    {
      const r = await mutate(userJar, '/api/compare', 'POST', { productId: idA });
      eq('[CMP3.6] idempotent POST status', 200, r.status);
      const after = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.6] still exactly 1 row', 1, after);
    }

    // (CMP3.7) 5th add (after seeding 3 more) → 409 COMPARE_FULL.
    {
      // Create extra products on the fly.
      const extras: string[] = [];
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: `${TAG_SLUG}-laptops` } });
      const brand = await prisma.brand.findUniqueOrThrow({ where: { slug: `${TAG_SLUG}-brand` } });
      for (let i = 0; i < 4; i++) {
        const p = await prisma.product.create({
          data: {
            sku: `${TAG}-EXTRA-${i}`,
            name: `Extra Laptop ${i}`,
            slug: `${TAG_SLUG}-extra-${i}`,
            description: 'fixture', categoryId: cat.id, brandId: brand.id,
            mrpPaise: 1000, pricePaise: 900, gstRate: 18, hsnCode: '8471',
            stock: 5, attributes: '{}', isActive: true,
          },
        });
        extras.push(p.id);
      }
      // We already have idA in the list. Add idB + extras[0] + extras[1]
      // (= 4 total). Then a 5th must 409.
      await mutate(userJar, '/api/compare', 'POST', { productId: idB });
      await mutate(userJar, '/api/compare', 'POST', { productId: extras[0] });
      await mutate(userJar, '/api/compare', 'POST', { productId: extras[1] });
      const r = await mutate(userJar, '/api/compare', 'POST', { productId: extras[2] });
      eq('[CMP3.7] 5th product status 409', 409, r.status);
      const env = r.body as Envelope;
      eq('[CMP3.7] error code = COMPARE_FULL', 'COMPARE_FULL', env.code);
    }

    // (CMP3.8) DELETE /api/compare/[productId] removes one row.
    {
      const r = await mutate(userJar, `/api/compare/${idA}`, 'DELETE');
      eq('[CMP3.8] DELETE status', 200, r.status);
      const exists = await prisma.compareItem.findUnique({
        where: { userId_productId: { userId, productId: idA } },
      });
      eq('[CMP3.8] row removed', null, exists);
    }

    // (CMP3.9) DELETE /api/compare clears the whole list.
    {
      const r = await mutate(userJar, '/api/compare', 'DELETE');
      eq('[CMP3.9] clear status', 200, r.status);
      const after = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.9] 0 rows remain', 0, after);
    }

    // (CMP3.10) Sync endpoint merges & de-duplicates.
    {
      // Seed: server has idA.
      await mutate(userJar, '/api/compare', 'POST', { productId: idA });
      // Sync: client says it has idA + idB locally.
      const r = await mutate(userJar, '/api/compare/sync', 'POST', { productIds: [idA, idB] });
      eq('[CMP3.10] sync status', 200, r.status);
      const after = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.10] final row count = 2 (deduped)', 2, after);
    }

    // (CMP3.11) Sync requires auth.
    {
      const jar = await withCsrf();
      const r = await mutate(jar, '/api/compare/sync', 'POST', { productIds: [idA] });
      eq('[CMP3.11] anonymous sync status 401', 401, r.status);
    }

    // (CMP3.12) Sync silently drops unknown / inactive ids.
    {
      // Wipe server list first.
      await mutate(userJar, '/api/compare', 'DELETE');
      const r = await mutate(userJar, '/api/compare/sync', 'POST', {
        productIds: [idA, 'invalid_id_x'],
      });
      eq('[CMP3.12] sync 200 even with bad ids', 200, r.status);
      const after = await prisma.compareItem.count({ where: { userId } });
      eq('[CMP3.12] only the valid id was inserted', 1, after);
    }

    // (CMP3.13) GET /compare page (share URL) renders both products.
    {
      const res = await fetch(`${BASE}/compare?products=${slugA},${slugB}`);
      const html = await res.text();
      assert('[CMP3.13] /compare?products=... returns 200', res.ok, res.status);
      assert('[CMP3.13] page mentions slug A',  html.includes(slugA), slugA);
      assert('[CMP3.13] page mentions slug B',  html.includes(slugB), slugB);
      assert('[CMP3.13] page header says "Shared comparison"',
        /Shared comparison/.test(html));
      assert('[CMP3.13] page renders the "Save to my compare" CTA',
        /Save to my compare/.test(html));
    }

    // (CMP3.14) Share URL silently drops slugs that violate the
    //   /^[a-z0-9-]+$/ validator. We can't simply look for ABSENCE
    //   of the literal in the HTML because Next.js echoes the request
    //   URL into the RSC payload — instead we verify the valid slug
    //   IS used to render a product (the page renders the shared
    //   header + a "Save to my compare" CTA, which the empty-state
    //   branch never emits).
    {
      const res = await fetch(`${BASE}/compare?products=${slugA},NOT-A-VALID-SLUG`);
      const html = await res.text();
      assert('[CMP3.14] /compare 200 when one slug is malformed',  res.ok, res.status);
      assert('[CMP3.14] page renders as a shared comparison (valid slug accepted)',
        /Shared comparison/.test(html));
      assert('[CMP3.14] page contains the valid slug as a product link',
        new RegExp(`href="/p/${slugA}"`).test(html),
        slugA);
    }

    // (CMP3.15) GET /compare with empty cookie + no products → empty state.
    {
      const res = await fetch(`${BASE}/compare`);
      const html = await res.text();
      assert('[CMP3.15] /compare 200',                       res.ok);
      assert('[CMP3.15] page renders empty-state copy',
        /No products to compare yet/.test(html));
    }

    // (CMP3.16) GET /compare with `?diff=1` reflects the toggle in the HTML.
    {
      // Seed cookie with two products so the toggle is meaningful.
      const cookie = encodeURIComponent(JSON.stringify([idA, idB]));
      const res = await fetch(`${BASE}/compare?diff=1`, {
        headers: { cookie: `sc_compare_v1=${cookie}` },
      });
      const html = await res.text();
      assert('[CMP3.16] /compare?diff=1 returns 200', res.ok, res.status);
      // The diff toggle markup includes the label text — we just verify
      // the toggle is checked. (DOM-checking is brittle in raw HTML, so
      // we assert the checkbox `checked` attribute is in the markup
      // somewhere near the "Show only differences" copy.)
      assert('[CMP3.16] "Show only differences" toggle is checked',
        /checked[^>]*>\s*Show only differences|Show only differences[\s\S]{0,200}checked/.test(html),
        'diff toggle not checked');
    }

    // (CMP3.17) features.compareEnabled = false → /compare 404 + API 403.
    //   Uses the admin PATCH endpoint to bust the 30s in-process cache
    //   atomically (no sleep).
    {
      const restore = await withStoreConfig({ 'features.compareEnabled': false });
      try {
        const r = await getJson('/api/compare', newJar());
        eq('[CMP3.17] GET /api/compare returns 403 when feature off', 403, r.status);
        const env = r.body as Envelope;
        eq('[CMP3.17] error code = FEATURE_DISABLED', 'FEATURE_DISABLED', env.code);
        const pageRes = await fetch(`${BASE}/compare`);
        eq('[CMP3.17] /compare page status 404 when feature off', 404, pageRes.status);
      } finally {
        await restore();
      }
    }
  } finally {
    await stopServer();
    await cleanup();
  }
}

async function cleanup(): Promise<void> {
  console.log('\n── cleanup ──');
  // Remove fixture rows in reverse FK order. We also opportunistically
  // sweep ALL rows with the `cmp_` / `cmp-` prefix in case a prior run
  // crashed midway.
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'cmp_' } },
    select: { id: true },
  });
  for (const u of users) {
    // Wipe every per-user side table the fixtures could have touched —
    // be defensive so cleanup never crashes from a stray row left by
    // an admin guard's audit trail.
    await prisma.compareItem.deleteMany({       where: { userId: u.id } });
    await prisma.session.deleteMany({           where: { userId: u.id } });
    await prisma.refreshTokenFamily.deleteMany({where: { userId: u.id } });
    await prisma.userActivity.deleteMany({      where: { userId: u.id } });
    await prisma.auditLog.deleteMany({          where: { actorId: u.id } });
    try {
      await prisma.user.delete({ where: { id: u.id } });
    } catch {
      // Last-resort soft-fail: leave the row, log nothing — the next
      // run's cleanup sweep gets a fresh chance.
    }
  }
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'cmp-' } } });
  await prisma.brand.deleteMany({    where: { slug: { startsWith: 'cmp-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'cmp-' } } });
  console.log(`  ✔ removed ${users.length} test user(s) + fixture products / brand / category`);
}

// ─────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    unitTests();
    staticAuditTests();
    await integrationTests();
  } catch (e) {
    failed++;
    const err = e as Error;
    console.error('  ✘ unhandled exception:', err.stack ?? err.message ?? String(e));
  } finally {
    await prisma.$disconnect();
    console.log(`\n── result ── ${passed} passed · ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
