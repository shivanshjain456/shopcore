/**
 * Homepage CMS — Item 18 Phase 1. Test harness.
 *
 *   npm run test:homepage-revamp
 *
 * Sections:
 *   1. UNIT          — section kind list, config schema validation
 *                      (per-kind happy path + rejection), safe-parse
 *                      defaults, section ordering, scheduling logic.
 *   2. SERVICE       — seed defaults idempotency; createSection +
 *                      updateSection + deleteSection + reorder;
 *                      metric + branch upsert/delete; resolved
 *                      composition includes only active in-window
 *                      sections; per-section resolver edge cases.
 *   3. STATIC AUDIT  — required files present; admin sidebar entry
 *                      (Phase 2); no hardcoded headings in the page;
 *                      every admin route audits.
 *   4. INTEGRATION   — spawn next start on port 3075; `GET /api/homepage`
 *                      returns the resolved composition; admin
 *                      sections/metrics/branches POST + PATCH + DELETE +
 *                      reorder; feature-flag off → page falls back to
 *                      legacy.
 *
 * Spec §4 — every assertion carries [HP<n>.<m>] tags.
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
  HOMEPAGE_SECTION_KINDS, isHomepageSectionKind,
  safeParseConfig, SECTION_CONFIG_SCHEMAS,
} from '../src/lib/cms/homepageSchemas';
import {
  seedDefaultsIfEmpty, getHomepageComposition,
  createSection, updateSection, deleteSection,
  reorderSections, listSectionsForAdmin,
  upsertMetric, deleteMetric, listMetricsForAdmin,
  upsertBranch, deleteBranch, listBranchesForAdmin,
} from '../src/lib/cms/homepage';
import { DEFAULT_HOMEPAGE_SECTIONS } from '../src/lib/cms/homepageDefaults';
import { ValidationError, NotFoundError } from '../src/lib/errors';

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

const TAG = `hp_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const TAG_SLUG = `hp-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const PORT = 3075;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-homepage-${process.pid}.log`;

// ─────────────────────────────────────────────────────────── 1. UNIT
function unitTests(): void {
  console.log('\n── UNIT — schemas, parsing, ordering ──');

  // (HP1.1) HOMEPAGE_SECTION_KINDS covers every documented kind.
  {
    const expected = [
      'HERO', 'FEATURED_BRANDS', 'TOP_CATEGORIES', 'PRODUCT_COLLECTION',
      'WIDE_PROMO_BANNER', 'DUAL_PROMO_CARDS', 'BRAND_SHOWCASE',
      'STORE_METRICS', 'WHY_SHOP_WITH_US', 'BRANCHES', 'NEWSLETTER',
      'MOST_RATED_PRODUCTS', 'TRENDING_PRODUCTS',
    ];
    for (const k of expected) {
      assert(`[HP1.1] kind ${k} registered`, isHomepageSectionKind(k));
    }
    eq('[HP1.1] kinds count matches', expected.length, HOMEPAGE_SECTION_KINDS.length);
  }

  // (HP1.2) isHomepageSectionKind rejects unknowns.
  assert('[HP1.2] unknown kind rejected', !isHomepageSectionKind('UNKNOWN_KIND'));
  assert('[HP1.2] empty string rejected',  !isHomepageSectionKind(''));
  assert('[HP1.2] non-string rejected',    !isHomepageSectionKind(42));

  // (HP1.3) Every kind has a schema in SECTION_CONFIG_SCHEMAS.
  for (const k of HOMEPAGE_SECTION_KINDS) {
    assert(`[HP1.3] schema exists for ${k}`, SECTION_CONFIG_SCHEMAS[k] !== undefined);
  }

  // (HP1.4) safeParseConfig — defaults apply on empty input.
  {
    const r = safeParseConfig('FEATURED_BRANDS', {});
    assert('[HP1.4] FEATURED_BRANDS empty config accepted', r.ok);
    if (r.ok) {
      const cfg = r.config as { source: string; maxItems: number; heading: string };
      eq('[HP1.4] default source = auto',   'auto',           cfg.source);
      eq('[HP1.4] default maxItems = 12',   12,               cfg.maxItems);
      eq('[HP1.4] default heading set',     'Shop by brand',  cfg.heading);
    }
  }

  // (HP1.5) safeParseConfig — JSON string accepted.
  {
    const r = safeParseConfig('PRODUCT_COLLECTION', '{"heading":"Hello","maxItems":4,"source":{"mode":"featured"}}');
    assert('[HP1.5] JSON string parses', r.ok);
    if (r.ok) {
      const cfg = r.config as { heading: string; maxItems: number };
      eq('[HP1.5] heading echoed', 'Hello', cfg.heading);
      eq('[HP1.5] maxItems echoed', 4, cfg.maxItems);
    }
  }

  // (HP1.6) safeParseConfig — garbage JSON falls back to defaults.
  {
    const r = safeParseConfig('PRODUCT_COLLECTION', 'this is not JSON');
    assert('[HP1.6] garbage JSON still parses to defaults', r.ok);
  }

  // (HP1.7) safeParseConfig — unknown kind returns error.
  {
    const r = safeParseConfig('UNKNOWN_KIND', {});
    assert('[HP1.7] unknown kind → error', !r.ok);
  }

  // (HP1.8) PRODUCT_COLLECTION discriminated source — rejects unknown mode.
  {
    const r = safeParseConfig('PRODUCT_COLLECTION', { source: { mode: 'made-up-mode' } });
    assert('[HP1.8] PRODUCT_COLLECTION rejects unknown mode', !r.ok);
  }

  // (HP1.9) WIDE_PROMO_BANNER — all fields optional.
  {
    const r = safeParseConfig('WIDE_PROMO_BANNER', {});
    assert('[HP1.9] WIDE_PROMO_BANNER accepts empty config', r.ok);
  }

  // (HP1.10) Scheduling helper — null windows = always visible.
  {
    const now = new Date();
    const inWindow = (startsAt: Date | null, endsAt: Date | null): boolean => {
      if (startsAt && startsAt.getTime() > now.getTime()) return false;
      if (endsAt && endsAt.getTime() < now.getTime())     return false;
      return true;
    };
    assert('[HP1.10] (null, null) → always visible',     inWindow(null, null));
    assert('[HP1.10] startsAt future → hidden',          !inWindow(new Date(now.getTime() + 60_000), null));
    assert('[HP1.10] endsAt past → hidden',              !inWindow(null, new Date(now.getTime() - 60_000)));
    assert('[HP1.10] (past, future) → visible',          inWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000)));
  }
}

// ──────────────────────────────────────────────────── 2. SERVICE TESTS
async function serviceTests(): Promise<void> {
  console.log('\n── SERVICE — seed, CRUD, composition ──');

  // Wipe any prior fixture rows to keep the suite hermetic.
  await wipeFixtures();

  // (HP2.1) seedDefaultsIfEmpty seeds when the table is empty.
  {
    await prisma.homepageSection.deleteMany({});
    await prisma.homepageMetric.deleteMany({});
    const r = await seedDefaultsIfEmpty();
    eq('[HP2.1] sections seeded count', DEFAULT_HOMEPAGE_SECTIONS.length, r.sectionsSeeded);
    assert('[HP2.1] metrics seeded ≥ 1', r.metricsSeeded >= 1, r.metricsSeeded);
    const total = await prisma.homepageSection.count();
    eq('[HP2.1] sections persisted', DEFAULT_HOMEPAGE_SECTIONS.length, total);
  }

  // (HP2.2) seedDefaultsIfEmpty is idempotent — second call no-ops.
  {
    const before = await prisma.homepageSection.count();
    const r = await seedDefaultsIfEmpty();
    const after = await prisma.homepageSection.count();
    eq('[HP2.2] sectionsSeeded = 0 on re-run', 0, r.sectionsSeeded);
    eq('[HP2.2] section count unchanged', before, after);
  }

  // (HP2.3) createSection writes a parseable row.
  let createdId = '';
  {
    const row = await createSection({
      kind: 'WIDE_PROMO_BANNER',
      slug: `${TAG_SLUG}-promo-1`,
      title: 'Test promo',
      displayOrder: 5000,
      isActive: true,
      config: { headline: 'Test', subheadline: 'Sub' },
    });
    createdId = row.id;
    eq('[HP2.3] kind preserved',     'WIDE_PROMO_BANNER', row.kind);
    eq('[HP2.3] slug normalised',    `${TAG_SLUG}-promo-1`, row.slug);
    eq('[HP2.3] order preserved',     5000, row.displayOrder);
    assert('[HP2.3] config parsed', (row.config as { headline?: string }).headline === 'Test');
  }

  // (HP2.4) createSection rejects unknown kind.
  {
    let threw = false;
    try { await createSection({ kind: 'NOT_A_KIND', slug: `${TAG_SLUG}-bad` }); }
    catch (e) { threw = e instanceof ValidationError; }
    assert('[HP2.4] unknown kind throws ValidationError', threw);
  }

  // (HP2.5) createSection rejects bad slug.
  {
    let threw = false;
    try { await createSection({ kind: 'HERO', slug: 'BAD SLUG WITH SPACES' }); }
    catch (e) { threw = e instanceof ValidationError; }
    assert('[HP2.5] bad slug throws ValidationError', threw);
  }

  // (HP2.6) updateSection patches the row, re-validates config.
  {
    const row = await updateSection(createdId, {
      title: 'Renamed',
      isActive: false,
      config: { headline: 'NEW HEADLINE' },
    });
    eq('[HP2.6] title updated',    'Renamed',      row.title);
    eq('[HP2.6] isActive updated', false,          row.isActive);
    assert('[HP2.6] config patched',  (row.config as { headline?: string }).headline === 'NEW HEADLINE');
  }

  // (HP2.7) updateSection rejects bad config.
  {
    let threw = false;
    try { await updateSection(createdId, { config: { source: { mode: 'bad' } } } as never); }
    catch (e) { threw = e instanceof ValidationError; }
    // WIDE_PROMO_BANNER doesn't care about `source`, so this should
    // pass. Use a PRODUCT_COLLECTION section instead.
    void threw;
    // Build a product-collection section to verify config rejection.
    const pc = await createSection({
      kind: 'PRODUCT_COLLECTION', slug: `${TAG_SLUG}-pc-bad`,
    });
    let threw2 = false;
    try { await updateSection(pc.id, { config: { source: { mode: 'definitely-not-a-mode' } } } as never); }
    catch (e) { threw2 = e instanceof ValidationError; }
    assert('[HP2.7] bad PRODUCT_COLLECTION source rejected', threw2);
    await deleteSection(pc.id);
  }

  // (HP2.8) updateSection on missing id throws NotFoundError.
  {
    let threw = false;
    try { await updateSection('does-not-exist', { isActive: true }); }
    catch (e) { threw = e instanceof NotFoundError; }
    assert('[HP2.8] missing id → NotFoundError', threw);
  }

  // (HP2.9) reorderSections re-numbers display order in 10s.
  {
    const all = await listSectionsForAdmin();
    const ids = all.map((r) => r.id);
    // Reverse the order.
    await reorderSections(ids.slice().reverse());
    const reordered = await listSectionsForAdmin();
    eq('[HP2.9] first row after reverse = last input id', ids[ids.length - 1], reordered[0]!.id);
    eq('[HP2.9] first row displayOrder = 10', 10, reordered[0]!.displayOrder);
    eq('[HP2.9] step = 10',                   20, reordered[1]!.displayOrder);
    // Restore original order so later tests are stable.
    await reorderSections(ids);
  }

  // (HP2.10) deleteSection idempotent.
  {
    await deleteSection(createdId);
    const gone = await prisma.homepageSection.findUnique({ where: { id: createdId } });
    eq('[HP2.10] row removed', null, gone);
    // Second delete must not throw.
    await deleteSection(createdId);
    ok('[HP2.10] second delete no-op');
  }

  // (HP2.11) getHomepageComposition returns active in-window sections.
  {
    const comp = await getHomepageComposition();
    assert('[HP2.11] composition returned ≥ 1 section', comp.sections.length >= 1, comp.sections.length);
    assert('[HP2.11] every section has a renderable kind',
      comp.sections.every((s) => isHomepageSectionKind(s.kind)));
  }

  // (HP2.12) getHomepageComposition filters scheduled-future sections.
  {
    const future = new Date(Date.now() + 24 * 3600_000);
    const row = await createSection({
      kind: 'WIDE_PROMO_BANNER',
      slug: `${TAG_SLUG}-future`,
      isActive: true,
      startsAt: future,
      config: { headline: 'Future' },
    });
    const comp = await getHomepageComposition();
    assert('[HP2.12] future-scheduled section not surfaced',
      !comp.sections.some((s) => s.id === row.id));
    await deleteSection(row.id);
  }

  // (HP2.13) getHomepageComposition filters inactive sections.
  {
    const row = await createSection({
      kind: 'WIDE_PROMO_BANNER',
      slug: `${TAG_SLUG}-inactive`,
      isActive: false,
      config: { headline: 'Inactive' },
    });
    const comp = await getHomepageComposition();
    assert('[HP2.13] inactive section not surfaced',
      !comp.sections.some((s) => s.id === row.id));
    await deleteSection(row.id);
  }

  // (HP2.14) Metric upsert + delete.
  {
    const m = await upsertMetric(null, { label: `${TAG} metric`, value: '99+', displayOrder: 1 });
    assert('[HP2.14] metric created with id', m.id.length > 0);
    eq('[HP2.14] label echoed',           `${TAG} metric`, m.label);
    const m2 = await upsertMetric(m.id, { label: m.label, value: '999+', displayOrder: 1 });
    eq('[HP2.14] value updated', '999+', m2.value);
    await deleteMetric(m.id);
    const list = await listMetricsForAdmin();
    assert('[HP2.14] deleted metric is gone', !list.some((x) => x.id === m.id));
  }

  // (HP2.15) Branch upsert + delete.
  {
    const b = await upsertBranch(null, { name: `${TAG} store`, city: 'Mumbai' });
    eq('[HP2.15] city echoed', 'Mumbai', b.city);
    const b2 = await upsertBranch(b.id, { name: b.name, city: 'Pune' });
    eq('[HP2.15] city updated', 'Pune', b2.city);
    await deleteBranch(b.id);
    const list = await listBranchesForAdmin();
    assert('[HP2.15] deleted branch is gone', !list.some((x) => x.id === b.id));
  }

  // (HP2.16) Metric upsert validates required fields.
  {
    let threw = false;
    try { await upsertMetric(null, { label: '', value: '' }); }
    catch (e) { threw = e instanceof ValidationError; }
    assert('[HP2.16] empty metric rejected', threw);
  }

  // (HP2.17) Branch upsert validates required fields.
  {
    let threw = false;
    try { await upsertBranch(null, { name: '', city: '' }); }
    catch (e) { threw = e instanceof ValidationError; }
    assert('[HP2.17] empty branch rejected', threw);
  }
}

// ──────────────────────────────────────────── 3. STATIC AUDIT
function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — files, audit wiring ──');

  // (HP3.1) New files present.
  for (const p of [
    'src/lib/cms/homepage.ts',
    'src/lib/cms/homepageSchemas.ts',
    'src/lib/cms/homepageDefaults.ts',
    'src/app/api/homepage/route.ts',
    'src/app/api/admin/homepage/sections/route.ts',
    'src/app/api/admin/homepage/sections/[id]/route.ts',
    'src/app/api/admin/homepage/sections/reorder/route.ts',
    'src/app/api/admin/homepage/metrics/route.ts',
    'src/app/api/admin/homepage/metrics/[id]/route.ts',
    'src/app/api/admin/homepage/branches/route.ts',
    'src/app/api/admin/homepage/branches/[id]/route.ts',
    'src/components/storefront/homepage/HomepageRenderer.tsx',
    'src/components/storefront/homepage/blocks.tsx',
    'src/app/(storefront)/page.tsx',
    'src/app/(storefront)/_legacy-page.tsx',
    'prisma/migrations/20260608120000_homepage_cms/migration.sql',
  ]) {
    assert(`[HP3.1] file exists: ${p}`, existsSync(p));
  }

  // (HP3.2) Page is CMS-driven (no hardcoded h2 headings in the
  //         CMS-mode branch). The hand-coded headings live in the
  //         _legacy-page fallback only.
  {
    const cmsPage = readFileSync('src/app/(storefront)/page.tsx', 'utf-8');
    assert('[HP3.2] page imports HomepageRenderer',
      /from\s+['"]@\/components\/storefront\/homepage\/HomepageRenderer['"]/.test(cmsPage));
    assert('[HP3.2] page imports getHomepageComposition',
      /getHomepageComposition/.test(cmsPage));
    assert('[HP3.2] page guards on isHomepageRevampEnabled',
      /isHomepageRevampEnabled/.test(cmsPage));
    // Strip comments so prose mentions don't count as hardcoded JSX.
    const cmsPageStripped = cmsPage
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert('[HP3.2] page contains no <h2 directly (delegated to blocks)',
      !/<h2[\s>]/.test(cmsPageStripped));
  }

  // (HP3.3) Every admin homepage route calls audit().
  for (const p of [
    'src/app/api/admin/homepage/sections/route.ts',
    'src/app/api/admin/homepage/sections/[id]/route.ts',
    'src/app/api/admin/homepage/sections/reorder/route.ts',
    'src/app/api/admin/homepage/metrics/route.ts',
    'src/app/api/admin/homepage/metrics/[id]/route.ts',
    'src/app/api/admin/homepage/branches/route.ts',
    'src/app/api/admin/homepage/branches/[id]/route.ts',
  ]) {
    const src = readFileSync(p, 'utf-8');
    // GET endpoints are read-only and don't audit; only fail if a
    // file has mutating verbs (POST/PATCH/DELETE) without audit().
    const mutating = /\bexport const (POST|PATCH|DELETE)\b/.test(src);
    if (!mutating) { ok(`[HP3.3] ${p} read-only, audit not required`); continue; }
    assert(`[HP3.3] ${p} calls audit()`, /\baudit\(/.test(src));
    assert(`[HP3.3] ${p} uses HOMEPAGE_ audit action`, /HOMEPAGE_/.test(src));
  }

  // (HP3.4) Feature-flag helpers exported.
  {
    const src = readFileSync('src/lib/storeConfig/featureGate.ts', 'utf-8');
    assert('[HP3.4] isHomepageRevampEnabled exported',  /export const isHomepageRevampEnabled/.test(src));
    assert('[HP3.4] isHomepageBrandsEnabled exported',  /export const isHomepageBrandsEnabled/.test(src));
    assert('[HP3.4] isHomepageMetricsEnabled exported', /export const isHomepageMetricsEnabled/.test(src));
    assert('[HP3.4] isHomepageBranchesEnabled exported',/export const isHomepageBranchesEnabled/.test(src));
  }

  // (HP3.5) Schema declares the 4 new flag keys.
  {
    const src = readFileSync('src/lib/storeConfig/schema.ts', 'utf-8');
    for (const k of [
      'features.homepageRevampEnabled',
      'features.homepageBrandsEnabled',
      'features.homepageMetricsEnabled',
      'features.homepageBranchesEnabled',
    ]) {
      assert(`[HP3.5] schema has '${k}'`, src.includes(`'${k}':`));
    }
  }

  // (HP3.6) `findMany` discipline in the new lib/cms/homepage.ts —
  //         every unbounded query must carry PAGINATION-EXEMPT.
  {
    const raw = readFileSync('src/lib/cms/homepage.ts', 'utf-8');
    const lines = raw.split('\n');
    let offenders = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/\.findMany\s*\(/.test(lines[i]!)) continue;
      // Window of 12 lines around the call.
      const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 12)).join('\n');
      if (/\btake\s*:/.test(window))             continue;
      if (/[,{(\s]take\s*[,}\n]/.test(window))   continue;
      if (/PAGINATION-EXEMPT/.test(window))      continue;
      offenders++;
    }
    eq('[HP3.6] lib/cms/homepage.ts unbounded findMany count = 0', 0, offenders);
  }
}

// ────────────────────────────────────────── 4. INTEGRATION
async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', JOB_RUNNER_ENABLED: 'false' },
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

async function withStoreConfig(jar: Jar, changes: Record<string, unknown>): Promise<() => Promise<void>> {
  // Read current values + PATCH the change atomically (the
  // store-config service invalidates the in-process cache on PATCH,
  // so the child server picks up changes immediately).
  const getRes = await fetch(`${BASE}/api/admin/store-config`, {
    headers: { cookie: cookieHeader(jar) },
  });
  const body = await getRes.json() as { data: { config: Record<string, unknown> } };
  const cfg = body.data.config;
  const original: Record<string, unknown> = {};
  for (const k of Object.keys(changes)) {
    const [head, leaf] = k.split('.');
    const cat = cfg[head] as Record<string, unknown> | undefined;
    original[k] = cat?.[leaf];
  }
  const patchHeaders = new Headers();
  patchHeaders.set('cookie', cookieHeader(jar));
  patchHeaders.set('content-type', 'application/json');
  if (jar.cookies['sc_csrf']) patchHeaders.set('x-csrf-token', jar.cookies['sc_csrf']);
  patchHeaders.set('origin', BASE);
  const patchRes = await fetch(`${BASE}/api/admin/store-config`, {
    method: 'PATCH', headers: patchHeaders,
    body: JSON.stringify({ changes }),
  });
  if (patchRes.status !== 200) {
    throw new Error(`PATCH /api/admin/store-config failed: ${patchRes.status}`);
  }
  return async () => {
    await fetch(`${BASE}/api/admin/store-config`, {
      method: 'PATCH', headers: patchHeaders,
      body: JSON.stringify({ changes: original }),
    });
  };
}

let _adminId: string | null = null;
async function getOrCreateAdmin(): Promise<string> {
  if (_adminId) return _adminId;
  const u = await prisma.user.create({
    data: {
      firstName: 'HP', lastName: 'Admin',
      email: `${TAG}_admin@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestHP'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: brand-new fixture admin.
      status: 'ACTIVE', phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  _adminId = u.id;
  return u.id;
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — endpoints + feature flag ──');
  await startServer();
  try {
    // (HP4.1) GET /api/homepage returns the composition.
    {
      const res = await fetch(`${BASE}/api/homepage`);
      eq('[HP4.1] status', 200, res.status);
      const env = await res.json() as { ok: boolean; data: { enabled: boolean; sections: unknown[] } };
      assert('[HP4.1] ok envelope',                env.ok === true);
      assert('[HP4.1] enabled = true by default',  env.data.enabled === true);
      assert('[HP4.1] sections is array',          Array.isArray(env.data.sections));
      assert('[HP4.1] at least one section',       env.data.sections.length >= 1);
    }

    // (HP4.2) GET /api/homepage cache header present.
    {
      const res = await fetch(`${BASE}/api/homepage`);
      const cc = res.headers.get('cache-control') ?? '';
      assert('[HP4.2] Cache-Control set', /max-age=\d+/.test(cc), cc);
    }

    // (HP4.3) Storefront / page renders the CMS sections.
    {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      assert('[HP4.3] / status 200',     res.ok);
      // The seeded "Featured" PRODUCT_COLLECTION heading is a stable
      // marker of CMS-mode rendering.
      assert('[HP4.3] CMS heading present', /Featured/.test(html));
    }

    // ── Admin flows ───────────────────────────────────────────────
    const adminId = await getOrCreateAdmin();
    const adminJar = await adminJarFor(adminId);

    // (HP4.4) GET /api/admin/homepage/sections returns the list.
    {
      const res = await fetch(`${BASE}/api/admin/homepage/sections`, {
        headers: { cookie: cookieHeader(adminJar) },
      });
      eq('[HP4.4] admin list status', 200, res.status);
      const env = await res.json() as { data: { items: unknown[]; availableKinds: string[] } };
      assert('[HP4.4] items is array', Array.isArray(env.data.items));
      assert('[HP4.4] availableKinds includes HERO', env.data.availableKinds.includes('HERO'));
    }

    // (HP4.5) Create a new section via admin POST.
    let createdId = '';
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/homepage/sections`, {
        method: 'POST', headers,
        body: JSON.stringify({
          kind: 'WHY_SHOP_WITH_US',
          slug: `${TAG_SLUG}-why`,
          title: 'Why shop with us',
          displayOrder: 9999,
          isActive: true,
          config: {
            heading: 'Why shop with us',
            cards: [
              { title: 'Genuine products', description: 'Verified suppliers only.' },
              { title: 'GST billing',      description: 'Itemised invoice in every order.' },
            ],
          },
        }),
      });
      eq('[HP4.5] create status', 200, res.status);
      const env = await res.json() as { data: { section: { id: string; slug: string } } };
      createdId = env.data.section.id;
      assert('[HP4.5] section persisted', createdId.length > 0);
    }

    // (HP4.6) The new section now appears in the storefront composition.
    {
      const res = await fetch(`${BASE}/api/homepage`);
      const env = await res.json() as { data: { sections: Array<{ id: string }> } };
      assert('[HP4.6] new section in /api/homepage',
        env.data.sections.some((s) => s.id === createdId));
    }

    // (HP4.7) PATCH disables the section.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/homepage/sections/${createdId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ isActive: false }),
      });
      eq('[HP4.7] patch status', 200, res.status);
      const homepage = await fetch(`${BASE}/api/homepage`);
      const env = await homepage.json() as { data: { sections: Array<{ id: string }> } };
      assert('[HP4.7] disabled section dropped from composition',
        !env.data.sections.some((s) => s.id === createdId));
    }

    // (HP4.8) DELETE removes the section.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/homepage/sections/${createdId}`, {
        method: 'DELETE', headers,
      });
      eq('[HP4.8] delete status', 200, res.status);
      const gone = await prisma.homepageSection.findUnique({ where: { id: createdId } });
      eq('[HP4.8] row gone', null, gone);
    }

    // (HP4.9) Metric POST round-trips.
    let metricId = '';
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/homepage/metrics`, {
        method: 'POST', headers,
        body: JSON.stringify({ label: `${TAG} metric`, value: '42K+' }),
      });
      eq('[HP4.9] metric create status', 200, res.status);
      const env = await res.json() as { data: { metric: { id: string } } };
      metricId = env.data.metric.id;
      // Cleanup.
      await fetch(`${BASE}/api/admin/homepage/metrics/${metricId}`, {
        method: 'DELETE', headers,
      });
    }

    // (HP4.10) Branch POST round-trips.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/homepage/branches`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: `${TAG} branch`, city: 'Mumbai' }),
      });
      eq('[HP4.10] branch create status', 200, res.status);
      const env = await res.json() as { data: { branch: { id: string } } };
      const branchId = env.data.branch.id;
      await fetch(`${BASE}/api/admin/homepage/branches/${branchId}`, {
        method: 'DELETE', headers,
      });
    }

    // (HP4.11) Reorder atomically renumbers.
    {
      const all = await listSectionsForAdmin();
      if (all.length >= 2) {
        const ids = all.map((r) => r.id);
        const headers = new Headers();
        headers.set('cookie', cookieHeader(adminJar));
        headers.set('content-type', 'application/json');
        if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
        headers.set('origin', BASE);
        const res = await fetch(`${BASE}/api/admin/homepage/sections/reorder`, {
          method: 'POST', headers,
          body: JSON.stringify({ orderedIds: ids.slice().reverse() }),
        });
        eq('[HP4.11] reorder status', 200, res.status);
        const after = await listSectionsForAdmin();
        eq('[HP4.11] first row is now the previous last',
          ids[ids.length - 1], after[0]!.id);
        // Restore.
        await fetch(`${BASE}/api/admin/homepage/sections/reorder`, {
          method: 'POST', headers,
          body: JSON.stringify({ orderedIds: ids }),
        });
      } else {
        ok('[HP4.11] skipped: < 2 sections');
      }
    }

    // (HP4.12) features.homepageRevampEnabled = false → page falls
    //          back to legacy layout (GET /api/homepage returns
    //          enabled: false + empty sections).
    {
      const restore = await withStoreConfig(adminJar, { 'features.homepageRevampEnabled': false });
      try {
        const res = await fetch(`${BASE}/api/homepage`);
        const env = await res.json() as { data: { enabled: boolean; sections: unknown[] } };
        eq('[HP4.12] flag off → enabled: false', false, env.data.enabled);
        eq('[HP4.12] flag off → sections: []',   0,     env.data.sections.length);
        // Page itself still 200s (renders the legacy layout).
        const page = await fetch(`${BASE}/`);
        eq('[HP4.12] page still 200 under legacy', 200, page.status);
      } finally {
        await restore();
      }
    }
  } finally {
    await stopServer();
    await wipeFixtures();
    await wipeAdmin();
  }
}

async function wipeFixtures(): Promise<void> {
  await prisma.homepageSection.deleteMany({
    where: { slug: { startsWith: 'hp-' } },
  });
  await prisma.homepageMetric.deleteMany({
    where: { label: { startsWith: 'hp_' } },
  });
  await prisma.homepageBranch.deleteMany({
    where: { name: { startsWith: 'hp_' } },
  });
}

async function wipeAdmin(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { email: { startsWith: 'hp_' } },
    select: { id: true },
  });
  for (const u of admins) {
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    try { await prisma.user.delete({ where: { id: u.id } }); } catch { /* leave */ }
  }
  console.log(`  ✔ removed ${admins.length} admin fixture(s)`);
}

// ─────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    unitTests();
    await serviceTests();
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
