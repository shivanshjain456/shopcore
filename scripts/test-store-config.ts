/**
 * Store Config + Feature Toggles — Item 8 Phase 1. Test harness.
 *
 *   npm run test:store-config
 *
 * Sections:
 *   1. UNIT      — schema completeness, derived types, validators, helpers
 *   2. SERVICE   — getStoreConfig, applyConfigPatch, cache, maintenance file
 *   3. STATIC    — file structure, DEFAULT_STORE_CONFIG migrated out of config.ts,
 *                  data/maintenance.json in .gitignore
 *   4. INTEGRATION — spawn `next start`, exercise GET / PATCH / export /
 *                    import / reset and the /maintenance redirect
 *
 * Phase 2 (admin tabbed UI + per-route feature gating) is NOT exercised
 * here — separate test:store-config-gating script will land with that phase.
 *
 * Every assertion carries a [S<n>.<m>] tag mapping to the spec acceptance
 * criteria.
 */
// Pre-import side-effects.
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';

import {
  CONFIG_SCHEMA, ALL_CONFIG_KEYS, isConfigKey,
  getStoreConfig, applyConfigPatch, invalidateConfigCache,
  flattenObject,
} from '../src/lib/storeConfig';
import { _resetConfigCacheForTests } from '../src/lib/storeConfig/cache';
import { validateConfigPatch } from '../src/lib/storeConfig/validation';
import {
  syncMaintenanceFile, readMaintenanceFile, isIpAllowedDuringMaintenance,
} from '../src/lib/storeConfig/maintenance';
import { CONFIG_CATEGORIES } from '../src/lib/storeConfig/schema';

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

const TAG = `sc_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const VALID_CATEGORIES = new Set(CONFIG_CATEGORIES);

const SINGLETON_BACKUP_PATH = `/tmp/sc-config-backup-${process.pid}.json`;

async function backupSingleton(): Promise<void> {
  const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
  writeFileSync(SINGLETON_BACKUP_PATH, JSON.stringify({ data: row?.data ?? '{}' }), 'utf-8');
}

async function restoreSingleton(): Promise<void> {
  try {
    const raw = readFileSync(SINGLETON_BACKUP_PATH, 'utf-8');
    const { data } = JSON.parse(raw) as { data: string };
    await prisma.storeConfig.upsert({
      where:  { id: 'singleton' },
      update: { data },
      create: { id: 'singleton', data },
    });
  } catch { /* */ }
  try { unlinkSync(SINGLETON_BACKUP_PATH); } catch { /* */ }
  // Also remove any maintenance.json the integration tests may have left.
  const mf = path.join(process.cwd(), 'data', 'maintenance.json');
  try { unlinkSync(mf); } catch { /* */ }
  invalidateConfigCache();
}

// ─────────────────────────────────────────────────────── 1. UNIT — schema
function unitTests(): void {
  console.log('\n── UNIT — schema completeness & validators ──');

  // (S1.1) Every entry has every required metadata field
  for (const key of ALL_CONFIG_KEYS) {
    const e = CONFIG_SCHEMA[key];
    assert(`[S1.1] "${key}" has label`,        typeof e.label === 'string' && e.label.length > 0);
    assert(`[S1.1] "${key}" has description`,  typeof e.description === 'string' && e.description.length > 0);
    assert(`[S1.1] "${key}" has category in CONFIG_CATEGORIES`,
      VALID_CATEGORIES.has(e.category));
    assert(`[S1.1] "${key}" has section`,      typeof e.section === 'string' && e.section.length > 0);
    assert(`[S1.1] "${key}" has type`,
      ['boolean', 'number', 'string', 'enum', 'json'].includes(e.type));
    // The key string and the dictionary key must match (avoids accidental
    // copy-paste drift between the property name and the .key attribute).
    eq(`[S1.1] "${key}" .key matches its dictionary key`, key, e.key);
  }

  // (S1.2) Type/default alignment for booleans + numbers
  for (const key of ALL_CONFIG_KEYS) {
    const e = CONFIG_SCHEMA[key];
    if (e.type === 'boolean') {
      assert(`[S1.2] "${key}" boolean has boolean default`, typeof e.default === 'boolean');
    } else if (e.type === 'number') {
      assert(`[S1.2] "${key}" number has number default`,   typeof e.default === 'number');
    } else if (e.type === 'string') {
      assert(`[S1.2] "${key}" string has string default`,   typeof e.default === 'string');
    } else if (e.type === 'enum') {
      assert(`[S1.2] "${key}" enum has options`, Array.isArray(e.enumOptions) && e.enumOptions!.length > 0);
    } else if (e.type === 'json') {
      assert(`[S1.2] "${key}" json default is array or object`,
        Array.isArray(e.default) || (e.default !== null && typeof e.default === 'object'));
    }
  }

  // (S1.3) Validators reject obviously-bad values
  const bad: Array<[string, unknown]> = [
    ['store.gstin',           'not-a-gstin'],            // wrong format
    ['store.pan',             'not-a-pan'],              // wrong format
    ['checkout.taxRatePercent', -5],                     // negative
    ['checkout.taxRatePercent', 200],                    // > 100
    ['payments.minOrderPaise', -1],                      // negative
    ['security.maxLoginAttempts', 0],                    // below min
    ['notifications.adminEmail', 'not-an-email'],        // bad email
    ['maintenance.bannerType',  'pink'],                 // out of enum
    ['maintenance.maintenanceEstimatedEnd', 'tomorrow'], // not ISO
  ];
  for (const [key, value] of bad) {
    const res = validateConfigPatch({ [key]: value });
    assert(`[S1.3] validator rejects "${key}" = ${JSON.stringify(value)}`,
      res.ok === false && key in (res as { errors: Record<string, string> }).errors);
  }

  // (S1.4) Validators accept reasonable values
  const good: Array<[string, unknown]> = [
    ['store.gstin',           '27AAACR5055K1Z6'],
    ['store.pan',             'AAACR5055K'],
    ['features.b2bEnabled',   false],
    ['features.b2bEnabled',   true],
    ['checkout.taxRatePercent', 18],
    ['maintenance.bannerType',  'warning'],
    ['maintenance.bannerExpiresAt', new Date(Date.now() + 60_000).toISOString()],
    ['security.allowedImageDomains', ['cdn.example.com', 'images.shopcore.test']],
    ['security.ipWhitelist',  ['127.0.0.1', '10.0.0.0/8']],
    ['notifications.adminEmail', ''],   // empty string allowed
    ['notifications.adminEmail', 'admin@example.com'],
  ];
  for (const [key, value] of good) {
    const res = validateConfigPatch({ [key]: value });
    assert(`[S1.4] validator accepts "${key}" = ${JSON.stringify(value)}`,
      res.ok === true,
      res.ok === false ? (res as { errors: Record<string, string> }).errors : undefined);
  }

  // (S1.5) Cross-field validation: payments.maxOrderPaise < min
  {
    const res = validateConfigPatch({
      'payments.minOrderPaise': 1_000,
      'payments.maxOrderPaise': 100,
    });
    assert('[S1.5] cross-field: max < min rejected',
      res.ok === false && 'payments.maxOrderPaise' in (res as { errors: Record<string, string> }).errors);
  }

  // (S1.6) Unknown keys rejected
  {
    const res = validateConfigPatch({ 'not.a.real.key': 'nope' });
    assert('[S1.6] unknown key rejected',
      res.ok === false && 'not.a.real.key' in (res as { errors: Record<string, string> }).errors);
  }

  // (S1.7) isConfigKey guard
  assert('[S1.7] isConfigKey TRUE for known key',  isConfigKey('features.b2bEnabled'));
  assert('[S1.7] isConfigKey FALSE for unknown',  !isConfigKey('not.a.real.key'));

  // (S1.8) flattenObject round-trip
  {
    const nested = { features: { b2bEnabled: true, wishlistEnabled: false }, store: { name: 'X' } };
    const flat   = flattenObject(nested);
    eq('[S1.8] flattenObject produces dot keys', true,
      flat['features.b2bEnabled'] === true
      && flat['features.wishlistEnabled'] === false
      && flat['store.name'] === 'X');
  }

  // (S1.9) Arrays are treated as leaf values (NOT recursed into)
  {
    const flat = flattenObject({ security: { allowedImageDomains: ['a.com', 'b.com'] } });
    assert('[S1.9] array values are leaves in flattenObject',
      Array.isArray(flat['security.allowedImageDomains'])
      && (flat['security.allowedImageDomains'] as string[]).length === 2);
  }
}

// ──────────────────────────────────────────── 2. SERVICE — DB-backed reads
async function serviceTests(): Promise<void> {
  console.log('\n── SERVICE — DB-backed config reads & writes ──');

  await backupSingleton();

  // (S2.1) getStoreConfig with NO singleton row → falls back to defaults
  //        (and lazily CREATES the row)
  await prisma.storeConfig.deleteMany({});
  _resetConfigCacheForTests();
  {
    const cfg = await getStoreConfig();
    eq('[S2.1] default features.b2bEnabled = true',  true,  cfg.features.b2bEnabled);
    eq('[S2.1] default maintenance.maintenanceMode = false', false, cfg.maintenance.maintenanceMode);
    eq('[S2.1] default store.name = ShopCore',       'ShopCore', cfg.store.name);
    const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
    assert('[S2.1] singleton row lazily created', row !== null);
  }

  // (S2.2) Partial DB override → merged correctly (false is preserved)
  await prisma.storeConfig.upsert({
    where: { id: 'singleton' },
    update: { data: JSON.stringify({ features: { b2bEnabled: false }, store: { name: 'OverridenName' } }) },
    create: { id: 'singleton', data: JSON.stringify({ features: { b2bEnabled: false } }) },
  });
  invalidateConfigCache();
  {
    const cfg = await getStoreConfig();
    eq('[S2.2] DB override "false" preserved (not coerced)', false, cfg.features.b2bEnabled);
    eq('[S2.2] DB string override applied',          'OverridenName', cfg.store.name);
    // Other defaults untouched
    eq('[S2.2] untouched defaults remain',           true,  cfg.features.wishlistEnabled);
  }

  // (S2.3) Invalid DB value → fallback to default (no throw)
  await prisma.storeConfig.update({
    where: { id: 'singleton' },
    data:  { data: JSON.stringify({ checkout: { taxRatePercent: 'not-a-number' } }) },
  });
  invalidateConfigCache();
  {
    const cfg = await getStoreConfig();
    eq('[S2.3] invalid value falls back to default', 18, cfg.checkout.taxRatePercent);
  }

  // (S2.4) Cache: two consecutive reads → second is a cache hit
  await prisma.storeConfig.update({
    where: { id: 'singleton' },
    data:  { data: JSON.stringify({ store: { name: 'CacheTest1' } }) },
  });
  invalidateConfigCache();
  const c1 = await getStoreConfig();
  // Mutate DB without invalidating the cache.
  await prisma.storeConfig.update({
    where: { id: 'singleton' },
    data:  { data: JSON.stringify({ store: { name: 'CacheTest2' } }) },
  });
  const c2 = await getStoreConfig();
  eq('[S2.4] cache returns stale value within TTL',  c1.store.name, c2.store.name);
  eq('[S2.4] cached value is "CacheTest1"',         'CacheTest1',  c2.store.name);

  // (S2.5) invalidateConfigCache → next read hits DB again
  invalidateConfigCache();
  const c3 = await getStoreConfig();
  eq('[S2.5] post-invalidate read sees new value', 'CacheTest2', c3.store.name);

  // (S2.6) applyConfigPatch — happy path
  {
    const res = await applyConfigPatch({ 'features.wishlistEnabled': false });
    assert('[S2.6] applyConfigPatch ok=true', res.ok === true);
    if (res.ok) {
      eq('[S2.6] after.features.wishlistEnabled = false', false, res.after.features.wishlistEnabled);
      eq('[S2.6] changedKeys lists the key', ['features.wishlistEnabled'], res.changedKeys);
    }
  }

  // (S2.7) applyConfigPatch — validation error → all-or-nothing
  {
    const beforeWish = (await getStoreConfig()).features.wishlistEnabled;
    const res = await applyConfigPatch({
      'features.wishlistEnabled': true,                 // valid
      'checkout.taxRatePercent': -99,                   // invalid
    });
    assert('[S2.7] applyConfigPatch ok=false on partial failure', res.ok === false);
    invalidateConfigCache();
    const after = await getStoreConfig();
    eq('[S2.7] NONE of the patch was applied (atomic)',
      beforeWish, after.features.wishlistEnabled);
  }

  // (S2.8) Maintenance file sync round-trip
  {
    await applyConfigPatch({
      'maintenance.maintenanceMode': true,
      'maintenance.maintenanceMessage': `unit-test ${TAG}`,
      'maintenance.allowedMaintenanceIps': ['127.0.0.1'],
    });
    const cfg = await getStoreConfig();
    await syncMaintenanceFile(cfg);
    const file = await readMaintenanceFile();
    assert('[S2.8] maintenance.json file read OK', file !== null);
    eq('[S2.8] file.enabled = true',  true, file?.enabled);
    eq('[S2.8] file.message round-tripped',  `unit-test ${TAG}`, file?.message);
    eq('[S2.8] file.allowedIps round-tripped', ['127.0.0.1'], file?.allowedIps);
  }

  // (S2.9) IP allow check
  {
    const cfg = await getStoreConfig();
    assert('[S2.9] allowed IP passes', isIpAllowedDuringMaintenance(cfg, '127.0.0.1'));
    assert('[S2.9] non-allowed IP blocked', !isIpAllowedDuringMaintenance(cfg, '10.10.10.10'));
    assert('[S2.9] null IP blocked during maintenance', !isIpAllowedDuringMaintenance(cfg, null));
  }
  {
    await applyConfigPatch({ 'maintenance.maintenanceMode': false });
    const cfg = await getStoreConfig();
    assert('[S2.9] any IP passes when maintenance off',
      isIpAllowedDuringMaintenance(cfg, null)
      && isIpAllowedDuringMaintenance(cfg, '99.99.99.99'));
  }

  // (S2.10) Unknown keys in DB blob are PRESERVED (forward-compat)
  {
    await prisma.storeConfig.update({
      where: { id: 'singleton' },
      data:  { data: JSON.stringify({ future: { someNewToggle: 'yes' } }) },
    });
    invalidateConfigCache();
    // Now PATCH a single known key — the unknown key must still be in the DB.
    await applyConfigPatch({ 'store.name': 'PreserveTest' });
    const row = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
    const blob = JSON.parse(row!.data) as Record<string, unknown>;
    const future = blob['future'] as Record<string, unknown> | undefined;
    eq('[S2.10] unknown DB key preserved across PATCH', 'yes', future?.someNewToggle);
  }

  // Restore DB so other tests aren't polluted.
  await restoreSingleton();
}

// ────────────────────────────────────────────── 3. STATIC — file structure
function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — file structure ──');

  const required = [
    'src/lib/storeConfig/schema.ts',
    'src/lib/storeConfig/defaults.ts',
    'src/lib/storeConfig/types.ts',
    'src/lib/storeConfig/cache.ts',
    'src/lib/storeConfig/validation.ts',
    'src/lib/storeConfig/index.ts',
    'src/lib/storeConfig/maintenance.ts',
    'src/app/maintenance/page.tsx',
    'src/components/storefront/AnnouncementBanner.tsx',
    'src/components/storefront/AnnouncementBannerClient.tsx',
    'src/app/api/admin/store-config/route.ts',
    'src/app/api/admin/store-config/export/route.ts',
    'src/app/api/admin/store-config/import/route.ts',
    'src/app/api/admin/store-config/reset/route.ts',
  ];
  for (const p of required) {
    assert(`[S3.1] file exists: ${p}`,
      existsSync(p) && fs.statSync(p).isFile());
  }

  // (S3.2) DEFAULT_STORE_CONFIG is RE-EXPORTED from lib/config (not defined there).
  const configSrc = readFileSync('src/lib/config.ts', 'utf-8');
  assert('[S3.2] lib/config.ts no longer defines DEFAULT_STORE_CONFIG inline',
    !/export const DEFAULT_STORE_CONFIG\s*=\s*\{/.test(configSrc));
  assert('[S3.2] lib/config.ts re-exports DEFAULT_STORE_CONFIG from new location',
    /export\s*\{\s*DEFAULT_STORE_CONFIG[\s\S]*?\}\s*from\s*['"]@\/lib\/storeConfig\/defaults['"]/
      .test(configSrc));

  // (S3.3) .gitignore protects runtime files
  const gi = readFileSync('.gitignore', 'utf-8');
  assert('[S3.3] data/maintenance.json in .gitignore',
    /^data\/maintenance\.json$/m.test(gi));

  // (S3.4) Root storefront layout calls getStoreConfig + redirects on maintenance
  const slayout = readFileSync('src/app/(storefront)/layout.tsx', 'utf-8');
  assert('[S3.4] storefront layout imports getStoreConfig',
    /from\s+['"]@\/lib\/storeConfig['"]/.test(slayout));
  assert('[S3.4] storefront layout redirects to /maintenance when on',
    /redirect\(['"]\/maintenance['"]\)/.test(slayout));
  assert('[S3.4] storefront layout renders AnnouncementBanner',
    /<AnnouncementBanner\s*\/>/.test(slayout));

  // (S3.5) No `cfg\.|config\.` references using string-literal fallbacks in
  // routes that should be config-driven — soft audit. Just count occurrences
  // of `getStoreConfig()` to ensure callers exist.
  // (Phase 2 will tighten this with a hardcoded toggle audit.)

  // (S3.6) Cache invalidation is wired in the PATCH handler.
  const patchSrc = readFileSync('src/app/api/admin/store-config/route.ts', 'utf-8');
  assert('[S3.6] PATCH handler invalidates cache (via applyConfigPatch or directly)',
    /invalidateConfigCache|applyConfigPatch/.test(patchSrc));

  // (S3.7) Reset endpoint uses the canonical confirmation literal.
  const resetSrc = readFileSync('src/app/api/admin/store-config/reset/route.ts', 'utf-8');
  assert('[S3.7] reset endpoint requires "RESET_ALL_CONFIG" confirmation',
    /z\.literal\(['"]RESET_ALL_CONFIG['"]\)/.test(resetSrc));
}

// ─────────────────── 4. INTEGRATION — spawn `next start`, exercise endpoints
const PORT = 3061;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-store-config-${process.pid}.log`;

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

interface ApiResp { status: number; body: Record<string, unknown>; headers: Headers; raw: string; }
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
    method, headers, redirect: 'manual',
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body, headers: res.headers, raw };
}

async function makeIntAdmin(): Promise<{ id: string; email: string }> {
  const email = `${TAG}_int_admin@shopcore.test`;
  const u = await prisma.user.create({
    data: {
      firstName: 'Int', lastName: 'Admin', email,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaScAdmin'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: test-fixture admin seeding — brand-new
      // admin row has no prior state, so the runtime state machine
      // (which governs TRANSITIONS) does not apply.
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return { id: u.id, email };
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — admin API end-to-end ──');

  await startServer();
  await backupSingleton();
  const admin = await makeIntAdmin();
  const adminJar = await sessionJarFor(admin.id, 'ADMIN');

  // (I1) GET — returns config + schema
  const get = await call(adminJar, '/api/admin/store-config');
  eq('[I1] GET → 200', 200, get.status);
  const getBody = get.body as { ok: boolean; data?: { config: Record<string, unknown>; schema: unknown[] } };
  assert('[I1] body has data.config + data.schema',
    getBody.ok === true && Array.isArray(getBody.data?.schema) && getBody.data?.config !== undefined);
  const schemaLen = (getBody.data!.schema as unknown[]).length;
  eq('[I1] schema length matches ALL_CONFIG_KEYS', ALL_CONFIG_KEYS.length, schemaLen);

  // (I2) Anonymous → 401/403
  const anon = await call(newJar(), '/api/admin/store-config');
  assert('[I2] anon → /api/admin/store-config rejected',
    anon.status === 401 || anon.status === 403, { status: anon.status });

  // (I3) PATCH new-shape — valid change → 200, value reflected
  const p1 = await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: { 'features.wishlistEnabled': false } } });
  eq('[I3] PATCH new-shape → 200', 200, p1.status);
  const p1Cfg = (p1.body as { data: { config: { features: { wishlistEnabled: boolean } } } }).data;
  eq('[I3] response config reflects change', false, p1Cfg.config.features.wishlistEnabled);

  // (I4) PATCH new-shape — invalid value → 400 CONFIG_VALIDATION_ERROR, no write
  const before = (await call(adminJar, '/api/admin/store-config')).body as { data: { config: { features: { wishlistEnabled: boolean } } } };
  const p2 = await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: {
      'features.wishlistEnabled': true,         // valid
      'checkout.taxRatePercent': -50,           // invalid
    }}});
  eq('[I4] PATCH bad value → 400', 400, p2.status);
  eq('[I4] error code = CONFIG_VALIDATION_ERROR',
    'CONFIG_VALIDATION_ERROR', (p2.body as { code: string }).code);
  const after = (await call(adminJar, '/api/admin/store-config')).body as { data: { config: { features: { wishlistEnabled: boolean } } } };
  eq('[I4] atomic — wishlistEnabled NOT changed',
    before.data.config.features.wishlistEnabled, after.data.config.features.wishlistEnabled);

  // (I5) PATCH new-shape — toggle maintenance ON, then verify storefront redirect
  await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: {
      'maintenance.maintenanceMode': true,
      'maintenance.maintenanceMessage': 'integration test maintenance',
    }}});
  // Storefront homepage → 307/308 redirect to /maintenance
  const homeDuringMaintenance = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert(`[I5] / redirects during maintenance (got ${homeDuringMaintenance.status})`,
    homeDuringMaintenance.status >= 300 && homeDuringMaintenance.status < 400,
    { status: homeDuringMaintenance.status });
  const loc = homeDuringMaintenance.headers.get('location') ?? '';
  assert('[I5] redirect location contains /maintenance',
    loc.includes('/maintenance'), { location: loc });

  // (I6) /maintenance page itself renders (200) — config-driven message
  const maintPage = await fetch(`${BASE}/maintenance`);
  eq('[I6] /maintenance → 200', 200, maintPage.status);
  const html = await maintPage.text();
  assert('[I6] page includes the admin-set maintenance message',
    html.includes('integration test maintenance'),
    { excerpt: html.slice(0, 400) });

  // (I7) Admin paths remain accessible during maintenance
  const adminGet = await call(adminJar, '/api/admin/store-config');
  eq('[I7] admin API still reachable during maintenance', 200, adminGet.status);

  // (I8) maintenance.json file was written
  const mfPath = path.join(process.cwd(), 'data', 'maintenance.json');
  assert('[I8] data/maintenance.json exists after maintenance toggle', existsSync(mfPath));
  const mfRead = JSON.parse(readFileSync(mfPath, 'utf-8')) as { enabled: boolean; message: string };
  eq('[I8] file.enabled = true', true, mfRead.enabled);
  eq('[I8] file.message round-tripped', 'integration test maintenance', mfRead.message);

  // (I9) Turn maintenance OFF, storefront accessible again
  await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: { 'maintenance.maintenanceMode': false } } });
  const homeAfter = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert(`[I9] / accessible after maintenance off (got ${homeAfter.status})`,
    homeAfter.status === 200, { status: homeAfter.status });

  // (I10) Announcement banner — toggle on, message renders in /
  await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: {
      'maintenance.bannerEnabled': true,
      'maintenance.bannerMessage': `banner-test-${TAG}`,
      'maintenance.bannerType':    'warning',
    }}});
  const homeWithBanner = await fetch(`${BASE}/`);
  const homeHtml = await homeWithBanner.text();
  assert('[I10] storefront home includes banner text',
    homeHtml.includes(`banner-test-${TAG}`),
    { excerpt: homeHtml.slice(0, 400) });

  // Turn banner off again so subsequent tests aren't polluted.
  await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: { 'maintenance.bannerEnabled': false } } });

  // (I11) EXPORT — content-disposition + valid JSON body
  const exp = await call(adminJar, '/api/admin/store-config/export',
    { method: 'POST' });
  eq('[I11] POST export → 200', 200, exp.status);
  const cd = exp.headers.get('content-disposition') ?? '';
  assert('[I11] export sets Content-Disposition: attachment',
    /attachment/i.test(cd) && /shopcore-config-/.test(cd),
    { cd });
  let parsed: unknown = null;
  try { parsed = JSON.parse(exp.raw); } catch { /* */ }
  assert('[I11] export body parses as JSON', parsed !== null);

  // (I12) IMPORT — preview phase (no confirmed)
  const preview = await call(adminJar, '/api/admin/store-config/import',
    { method: 'POST', json: { config: parsed } });
  eq('[I12] import preview → 200', 200, preview.status);
  const previewData = (preview.body as { data: { preview: boolean; diff: unknown[] } }).data;
  eq('[I12] preview flag set', true, previewData.preview);
  assert('[I12] preview returns a diff array', Array.isArray(previewData.diff));

  // (I13) IMPORT — apply phase with a tweaked value
  const tweaked = JSON.parse(exp.raw) as Record<string, unknown>;
  // Tweak features.compareEnabled to a different value
  const features = (tweaked.features as Record<string, unknown>) ?? {};
  const prevCompare = features.compareEnabled as boolean;
  features.compareEnabled = !prevCompare;
  tweaked.features = features;
  const apply = await call(adminJar, '/api/admin/store-config/import',
    { method: 'POST', json: { config: tweaked, confirmed: true } });
  eq('[I13] import apply → 200', 200, apply.status);
  const after13 = await call(adminJar, '/api/admin/store-config');
  const afterCfg = (after13.body as { data: { config: { features: { compareEnabled: boolean } } } }).data.config;
  eq('[I13] applied value reflected', !prevCompare, afterCfg.features.compareEnabled);

  // (I14) RESET — wrong confirmation rejected
  const r1 = await call(adminJar, '/api/admin/store-config/reset',
    { method: 'POST', json: { confirm: 'WRONG' } });
  eq('[I14] reset bad confirm → 400', 400, r1.status);

  // (I15) RESET — correct confirmation → all values back to defaults
  // First make a change so we can prove the reset undid it.
  await call(adminJar, '/api/admin/store-config',
    { method: 'PATCH', json: { changes: { 'store.name': 'NotShopCore' } } });
  const r2 = await call(adminJar, '/api/admin/store-config/reset',
    { method: 'POST', json: { confirm: 'RESET_ALL_CONFIG' } });
  eq('[I15] reset correct confirm → 200', 200, r2.status);
  const post = await call(adminJar, '/api/admin/store-config');
  const postCfg = (post.body as { data: { config: { store: { name: string } } } }).data.config;
  eq('[I15] store.name reset to default', 'ShopCore', postCfg.store.name);

  await restoreSingleton();
  await stopServer();
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const RUN_INT = process.env.SHOPCORE_SKIP_INT !== '1';
  try {
    unitTests();
    await serviceTests();
    staticAuditTests();
    if (RUN_INT) {
      await integrationTests();
    } else {
      console.log('\n── INTEGRATION — SKIPPED (SHOPCORE_SKIP_INT=1) ──');
    }
  } finally {
    await stopServer();
    await restoreSingleton();
    // Cleanup admin user + sessions
    const ids = (await prisma.user.findMany({
      where: { email: { contains: 'sc_' } }, select: { id: true },
    })).map((u) => u.id);
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
