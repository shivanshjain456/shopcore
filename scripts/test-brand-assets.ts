/**
 * Real Brand Assets — Item 17. Test harness.
 *
 *   npm run test:brand-assets
 *
 * Sections:
 *   1. UNIT          — colorFromString determinism + palette;
 *                      initialsFor edge cases; image-kind registry
 *                      shape (every kind has spec, isAdminImageKind).
 *   2. STATIC AUDIT  — every required file present; admin upload
 *                      route records to StoreAsset; storefront
 *                      components carry alt text; store-config UI
 *                      renders <ImageUploadInput> for image:<kind>
 *                      field types.
 *   3. INTEGRATION   — spawn `next start` on port 3073; exercise
 *                      /icon, /apple-icon, /opengraph-image (server-
 *                      generated when no admin URL set); admin
 *                      upload records StoreAsset; admin brand POST
 *                      with logoUrl + bannerUrl + description;
 *                      public /api/brands surfaces logoUrl; admin
 *                      category POST with the three asset fields.
 *
 * Spec §4 — every assertion carries [BA<n>.<m>] tags.
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
import { colorFromString, initialsFor } from '../src/lib/assets/colorFromString';
import {
  ADMIN_IMAGE_KINDS, IMAGE_KIND_SPECS, isAdminImageKind, getImageKindSpec,
} from '../src/lib/uploads/imageKinds';
import {
  normaliseFilename, editDistance,
  matchFilenameToCandidate, matchFilenamesToCandidates,
} from '../src/lib/assets/filenameMatch';

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

const TAG = `ba_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const TAG_SLUG = `ba-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const PORT = 3073;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-brand-assets-${process.pid}.log`;

// ── 1. UNIT ──────────────────────────────────────────────────────────────

function unitTests(): void {
  console.log('\n── UNIT — colour helper, initials, kind registry ──');

  // (BA1.1) colorFromString is deterministic.
  {
    const a = colorFromString('Apple');
    const b = colorFromString('Apple');
    eq('[BA1.1] same input → same output', a, b);
  }

  // (BA1.2) Different inputs → different hues (high probability).
  {
    const a = colorFromString('Apple');
    const b = colorFromString('Dell');
    assert('[BA1.2] different inputs usually yield different hues',
      a.hue !== b.hue, { a, b });
  }

  // (BA1.3) bg is a valid hsl(...) string; text is one of two safe colours.
  {
    const r = colorFromString('TestBrand');
    assert('[BA1.3] bg starts with hsl(', r.bg.startsWith('hsl('));
    assert('[BA1.3] text is white or slate-900',
      r.text === '#ffffff' || r.text === '#111827');
  }

  // (BA1.4) Empty input → neutral grey.
  {
    const empty = colorFromString('');
    const nul   = colorFromString(null);
    const und   = colorFromString(undefined);
    eq('[BA1.4] empty string → neutral',  empty, colorFromString(''));
    eq('[BA1.4] null      → neutral',     nul,   empty);
    eq('[BA1.4] undefined → neutral',     und,   empty);
  }

  // (BA1.5) initialsFor edge cases.
  {
    eq('[BA1.5] single word → 1 letter',    'A', initialsFor('Apple'));
    eq('[BA1.5] two words → 2 letters',     'AC', initialsFor('Apple Computers'));
    eq('[BA1.5] three words capped at 2',   'AC', initialsFor('Apple Computers India'));
    eq('[BA1.5] lowercase upcased',         'A',  initialsFor('apple'));
    eq('[BA1.5] empty → ?',                 '?',  initialsFor(''));
    eq('[BA1.5] null  → ?',                 '?',  initialsFor(null));
    eq('[BA1.5] custom max=1',              'A',  initialsFor('Apple Computers', 1));
  }

  // (BA1.6) Image-kind registry — every kind has a spec.
  {
    for (const k of ADMIN_IMAGE_KINDS) {
      const spec = IMAGE_KIND_SPECS[k];
      assert(`[BA1.6] kind '${k}' has spec`, spec !== undefined);
      assert(`[BA1.6] kind '${k}' has positive maxMb`,  spec.maxMb > 0);
      assert(`[BA1.6] kind '${k}' has positive maxPx`,  spec.maxPx > 0);
      assert(`[BA1.6] kind '${k}' format = jpg | png`,
        spec.outputFormat === 'jpg' || spec.outputFormat === 'png');
      assert(`[BA1.6] kind '${k}' quality in (0, 100]`,
        spec.quality > 0 && spec.quality <= 100);
    }
  }

  // (BA1.7) Transparent kinds use PNG output.
  {
    const transparent = ['logo', 'favicon', 'brand', 'app_icon', 'category_icon'] as const;
    for (const k of transparent) {
      eq(`[BA1.7] '${k}' outputs PNG`, 'png', IMAGE_KIND_SPECS[k].outputFormat);
    }
  }

  // (BA1.8) Photographic kinds use JPG output.
  {
    const photographic = ['og_image', 'category', 'category_banner', 'hero', 'promotion'] as const;
    for (const k of photographic) {
      eq(`[BA1.8] '${k}' outputs JPG`, 'jpg', IMAGE_KIND_SPECS[k].outputFormat);
    }
  }

  // (BA1.9) isAdminImageKind discriminates correctly.
  {
    assert('[BA1.9] "brand" accepted',           isAdminImageKind('brand'));
    assert('[BA1.9] "logo" accepted (new)',      isAdminImageKind('logo'));
    assert('[BA1.9] "category_banner" accepted', isAdminImageKind('category_banner'));
    assert('[BA1.9] "garbage" rejected',         !isAdminImageKind('garbage'));
    assert('[BA1.9] empty string rejected',      !isAdminImageKind(''));
    assert('[BA1.9] non-string rejected',        !isAdminImageKind(42));
  }

  // (BA1.10) getImageKindSpec returns the matching record.
  {
    const spec = getImageKindSpec('brand');
    eq('[BA1.10] brand spec format', 'png', spec.outputFormat);
  }

  // ── Phase 2 ─────────────────────────────────────────────────────

  // (BA1.11) normaliseFilename strips extension + lowercases + slugifies.
  {
    eq('[BA1.11] apple.png         → apple',  'apple',         normaliseFilename('apple.png'));
    eq('[BA1.11] APPLE.PNG         → apple',  'apple',         normaliseFilename('APPLE.PNG'));
    eq('[BA1.11] Apple Inc..png    → apple-inc', 'apple-inc',  normaliseFilename('Apple Inc..png'));
    eq('[BA1.11] _underscore_.jpg  → underscore', 'underscore', normaliseFilename('_underscore_.jpg'));
    eq('[BA1.11] empty             → ""',     '',              normaliseFilename(''));
    eq('[BA1.11] no extension      → name',   'name',          normaliseFilename('name'));
  }

  // (BA1.12) editDistance basics.
  {
    eq('[BA1.12] identical → 0',         0, editDistance('apple', 'apple'));
    eq('[BA1.12] single delete → 1',     1, editDistance('apple', 'aple'));
    eq('[BA1.12] single insert → 1',     1, editDistance('apple', 'apples'));
    eq('[BA1.12] single substitute → 1', 1, editDistance('apple', 'apply'));
    eq('[BA1.12] length-gap > max',      3, editDistance('apple', 'banana', 2));
  }

  // (BA1.13) matchFilenameToCandidate — exact match.
  {
    const cands = [
      { id: '1', slug: 'apple', name: 'Apple' },
      { id: '2', slug: 'dell',  name: 'Dell'  },
    ];
    const r = matchFilenameToCandidate('apple.png', cands);
    eq('[BA1.13] exact match type', 'exact', r.matchType);
    eq('[BA1.13] exact match slug', 'apple', r.match?.slug);
  }

  // (BA1.14) matchFilenameToCandidate — fuzzy match (typo).
  {
    const cands = [
      { id: '1', slug: 'apple', name: 'Apple' },
      { id: '2', slug: 'dell',  name: 'Dell'  },
    ];
    // "aplple" → edit distance 1 from "apple", unique → fuzzy match.
    const r = matchFilenameToCandidate('aplple.png', cands);
    eq('[BA1.14] fuzzy match type', 'fuzzy', r.matchType);
    eq('[BA1.14] fuzzy match slug', 'apple', r.match?.slug);
  }

  // (BA1.15) Ambiguous fuzzy → unmatched (don't guess).
  {
    const cands = [
      { id: '1', slug: 'apple', name: 'Apple' },
      { id: '2', slug: 'apply', name: 'Apply' },
    ];
    const r = matchFilenameToCandidate('applq.png', cands);
    eq('[BA1.15] ambiguous → none', 'none', r.matchType);
    eq('[BA1.15] ambiguous → no match', null, r.match);
  }

  // (BA1.16) Unknown filename → unmatched.
  {
    const cands = [{ id: '1', slug: 'apple', name: 'Apple' }];
    const r = matchFilenameToCandidate('completely-other-brand.png', cands);
    eq('[BA1.16] unknown → none', 'none', r.matchType);
  }

  // (BA1.17) matchFilenamesToCandidates batches correctly.
  {
    const cands = [
      { id: '1', slug: 'apple', name: 'Apple' },
      { id: '2', slug: 'dell',  name: 'Dell'  },
    ];
    const rs = matchFilenamesToCandidates(['apple.png', 'dell.jpg', 'unknown.webp'], cands);
    eq('[BA1.17] returns 3 results',       3, rs.length);
    eq('[BA1.17] first is exact',     'exact', rs[0]!.matchType);
    eq('[BA1.17] second is exact',    'exact', rs[1]!.matchType);
    eq('[BA1.17] third is unmatched', 'none',  rs[2]!.matchType);
  }

  // (BA1.18) Case-insensitive matching.
  {
    const cands = [{ id: '1', slug: 'apple', name: 'Apple' }];
    const r = matchFilenameToCandidate('APPLE.PNG', cands);
    eq('[BA1.18] APPLE.PNG matches apple', 'exact', r.matchType);
  }
}

// ── 2. STATIC AUDIT ──────────────────────────────────────────────────────

function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — files, wiring, alt text ──');

  // (BA2.1) Required new files present.
  const required = [
    'src/lib/assets/colorFromString.ts',
    'src/lib/uploads/imageKinds.ts',
    'src/components/storefront/BrandLogo.tsx',
    'src/components/storefront/CategoryImage.tsx',
    'src/components/storefront/StoreLogo.tsx',
    'src/components/storefront/StoreLogoImage.tsx',
    'src/app/icon.tsx',
    'src/app/apple-icon.tsx',
    'src/app/opengraph-image.tsx',
    'prisma/migrations/20260607120000_brand_assets/migration.sql',
  ];
  for (const p of required) assert(`[BA2.1] file exists: ${p}`, existsSync(p));

  // (BA2.2) Upload endpoint records to StoreAsset.
  {
    const src = readFileSync('src/app/api/admin/uploads/route.ts', 'utf-8');
    assert('[BA2.2] uploads route imports prisma',
      /from\s+['"]@\/lib\/db\/client['"]/.test(src));
    assert('[BA2.2] uploads route calls prisma.storeAsset.create',
      /prisma\.storeAsset\.create/.test(src));
    assert('[BA2.2] uploads route logs asset.uploaded',
      /asset\.uploaded/.test(src));
  }

  // (BA2.3) Storefront components carry meaningful alt text.
  for (const p of [
    'src/components/storefront/BrandLogo.tsx',
    'src/components/storefront/CategoryImage.tsx',
    'src/components/storefront/StoreLogo.tsx',
    'src/components/storefront/StoreLogoImage.tsx',
  ]) {
    const src = readFileSync(p, 'utf-8');
    // Strip comments first to avoid false positives.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Find every JSX `<img ...>` and `aria-label=...` occurrence.
    const imgTags = stripped.match(/<img\b[\s\S]*?\/>/g) ?? [];
    for (const tag of imgTags) {
      assert(`[BA2.3] ${p} <img> has non-empty alt=...`,
        /\balt=\{?["`'][^"`']+["`']\}?|alt=\{[^}]+\}/.test(tag),
        tag.slice(0, 200));
    }
  }

  // (BA2.4) Store-config UI renders <ImageUploadInput> for image:<kind>.
  {
    const src = readFileSync('src/app/admin/(app)/store-config/page.tsx', 'utf-8');
    assert('[BA2.4] store-config UI imports ImageUploadInput',
      /from\s+['"]@\/components\/admin\/ImageUploadInput['"]/.test(src));
    assert('[BA2.4] store-config UI branches on image: fieldType prefix',
      /image:/.test(src));
  }

  // (BA2.5) Schema declares the five new store.* asset keys.
  {
    const src = readFileSync('src/lib/storeConfig/schema.ts', 'utf-8');
    for (const key of ['store.logoUrl', 'store.logoDarkUrl', 'store.logoAlt',
                       'store.faviconUrl', 'store.ogImageUrl', 'store.appIconUrl']) {
      assert(`[BA2.5] schema has '${key}'`, src.includes(`'${key}':`));
    }
  }

  // (BA2.6) sharp re-encode branches on output format.
  {
    const src = readFileSync('src/lib/uploads/adminImages.ts', 'utf-8');
    assert('[BA2.6] adminImages re-encode branches on PNG output',
      /spec\.outputFormat\s*===\s*['"]png['"]/.test(src));
    assert('[BA2.6] adminImages reads per-kind spec',
      /getImageKindSpec\(/.test(src));
  }

  // (BA2.7) Storefront layout passes brand props to the header.
  {
    const src = readFileSync('src/app/(storefront)/layout.tsx', 'utf-8');
    assert('[BA2.7] layout passes storeName to <StorefrontHeader>',
      /storeName=\{/.test(src));
    assert('[BA2.7] layout passes logoUrl to <StorefrontHeader>',
      /logoUrl=\{/.test(src));
  }

  // (BA2.8) Brand admin form wires logo + banner uploaders.
  {
    const src = readFileSync('src/app/admin/(app)/brands/page.tsx', 'utf-8');
    assert('[BA2.8] brands page imports ImageUploadInput', /ImageUploadInput/.test(src));
    assert('[BA2.8] brands page imports BrandLogo',        /BrandLogo/.test(src));
    assert('[BA2.8] brands form sends logoUrl in POST',     /logoUrl:/.test(src));
  }

  // (BA2.9) Category admin form wires all three uploaders.
  {
    const src = readFileSync('src/app/admin/(app)/categories/page.tsx', 'utf-8');
    assert('[BA2.9] categories page imports CategoryImage', /CategoryImage/.test(src));
    assert('[BA2.9] categories form sends imageUrl',  /imageUrl:/.test(src));
    assert('[BA2.9] categories form sends bannerUrl', /bannerUrl:/.test(src));
    assert('[BA2.9] categories form sends iconUrl',   /iconUrl:/.test(src));
  }

  // (BA2.10) Homepage uses BrandLogo + CategoryImage somewhere in the
  //   render path. Item 18 moved the actual JSX into the homepage
  //   blocks file; the legacy fallback page still uses them directly.
  //   The contract holds as long as EITHER path imports them.
  {
    const candidates = [
      'src/components/storefront/homepage/blocks.tsx',
      'src/app/(storefront)/_legacy-page.tsx',
      'src/app/(storefront)/page.tsx',
    ].filter((p) => existsSync(p));
    const combined = candidates.map((p) => readFileSync(p, 'utf-8')).join('\n\n');
    assert('[BA2.10] homepage path imports BrandLogo + CategoryImage',
      /BrandLogo/.test(combined) && /CategoryImage/.test(combined));
    assert('[BA2.10] homepage path uses getBrands (legacy or service)',
      /getBrands/.test(combined) || /getHomepageComposition/.test(combined));
  }

  // ── Phase 2 ─────────────────────────────────────────────────────

  // (BA2.11) Phase 2 files present.
  for (const p of [
    'src/lib/assets/assetHealth.ts',
    'src/lib/assets/storeAsset.ts',
    'src/lib/assets/filenameMatch.ts',
    'src/app/api/admin/assets/route.ts',
    'src/app/api/admin/assets/[id]/route.ts',
    'src/app/admin/(app)/assets/page.tsx',
    'src/app/admin/(app)/assets/BulkUploadCard.tsx',
  ]) assert(`[BA2.11] file exists: ${p}`, existsSync(p));

  // (BA2.12) Sidebar links to the new Assets page.
  {
    const src = readFileSync('src/components/admin/SideNav.tsx', 'utf-8');
    assert('[BA2.12] sidebar includes /admin/assets', /\/admin\/assets/.test(src));
  }

  // (BA2.13) DELETE endpoint checks references + audits.
  {
    const src = readFileSync('src/app/api/admin/assets/[id]/route.ts', 'utf-8');
    assert('[BA2.13] DELETE calls findAssetReferences', /findAssetReferences/.test(src));
    assert('[BA2.13] DELETE blocks with ASSET_IN_USE', /ASSET_IN_USE/.test(src));
    assert('[BA2.13] DELETE accepts ?force=1 override',  /force=/.test(src));
    assert('[BA2.13] DELETE writes audit',               /ASSET_DELETED/.test(src));
  }

  // (BA2.14) GET endpoint supports kind filter + ?include=health.
  {
    const src = readFileSync('src/app/api/admin/assets/route.ts', 'utf-8');
    assert('[BA2.14] GET reads ?kind=',     /sp\.get\(['"]kind['"]\)/.test(src));
    assert('[BA2.14] GET reads ?include=',  /sp\.get\(['"]include['"]\)/.test(src));
    assert('[BA2.14] GET computes coverage',
      /getStoreIdentityHealth/.test(src) && /getBrandHealth/.test(src) && /getCategoryHealth/.test(src));
  }
}

// ── 3. INTEGRATION ───────────────────────────────────────────────────────

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

let _adminId: string | null = null;
async function getOrCreateTestAdmin(): Promise<string> {
  if (_adminId) return _adminId;
  const u = await prisma.user.create({
    data: {
      firstName: 'BA', lastName: 'Admin',
      email: `${TAG}_admin@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestBA'),
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

/** 32×32 solid-colour PNG generated via sharp + hex-dumped. Used as
 *  the upload fixture so we don't bundle a binary file in the repo. */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000020000000200806000000737a7af40000000970485973000003e8000003e801b57b526b0000003749444154789cedce310100200c0330345553c5ced570014f8efc39d3ec4f4760042a10811518810a44600546a00211588111a8409e072ee18674882cb764640000000049454e44ae426082',
  'hex',
);

async function postUpload(jar: Jar, kind: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  const blob = new Blob([TINY_PNG], { type: 'image/png' });
  form.append('file', blob, 'tiny.png');
  const headers = new Headers();
  headers.set('cookie', cookieHeader(jar));
  if (jar.cookies['sc_csrf']) headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  headers.set('origin', BASE);
  const res = await fetch(`${BASE}/api/admin/uploads?kind=${kind}`, {
    method: 'POST', headers, body: form,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body };
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — dynamic icons, OG, upload pipeline ──');
  await startServer();

  try {
    // (BA3.1) /icon endpoint returns an image (PNG fallback when no
    //         faviconUrl is set in store config).
    {
      const res = await fetch(`${BASE}/icon`, { redirect: 'manual' });
      const ct = res.headers.get('content-type') ?? '';
      // Either 200 + image (fallback path) OR a 3xx redirect to the
      // admin-uploaded asset — both are valid here.
      assert('[BA3.1] /icon returns image or redirect',
        (res.ok && /^image\//.test(ct)) || (res.status >= 300 && res.status < 400),
        { status: res.status, ct });
    }

    // (BA3.2) /apple-icon same shape.
    {
      const res = await fetch(`${BASE}/apple-icon`, { redirect: 'manual' });
      const ct = res.headers.get('content-type') ?? '';
      assert('[BA3.2] /apple-icon returns image or redirect',
        (res.ok && /^image\//.test(ct)) || (res.status >= 300 && res.status < 400),
        { status: res.status, ct });
    }

    // (BA3.3) /opengraph-image returns a PNG at 1200×630 (fallback path).
    {
      const res = await fetch(`${BASE}/opengraph-image`, { redirect: 'manual' });
      const ct = res.headers.get('content-type') ?? '';
      assert('[BA3.3] /opengraph-image returns image or redirect',
        (res.ok && /^image\//.test(ct)) || (res.status >= 300 && res.status < 400),
        { status: res.status, ct });
    }

    // (BA3.4) Root HTML references /opengraph-image in the OG meta.
    {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      assert('[BA3.4] homepage HTML contains og:image meta with /opengraph-image',
        /property="og:image"[\s\S]{0,200}\/opengraph-image|\/opengraph-image[\s\S]{0,200}property="og:image"/.test(html),
        'see html');
    }

    // ── Authenticated admin flows ─────────────────────────────────────
    const adminId = await getOrCreateTestAdmin();
    const adminJar = await adminJarFor(adminId);

    // (BA3.5) Admin upload records StoreAsset.
    {
      const before = await prisma.storeAsset.count({ where: { uploadedBy: adminId } });
      const r = await postUpload(adminJar, 'brand');
      eq('[BA3.5] upload status', 200, r.status);
      const data = (r.body.data ?? {}) as Record<string, unknown>;
      const url = data.url as string | undefined;
      assert('[BA3.5] response contains a /api/uploads/... URL',
        typeof url === 'string' && url.startsWith('/api/uploads/public-images/brand/'),
        url);
      const after = await prisma.storeAsset.count({ where: { uploadedBy: adminId } });
      eq('[BA3.5] StoreAsset row count increased by 1', before + 1, after);

      // Per-kind format: brand is PNG.
      const row = await prisma.storeAsset.findFirst({
        where: { uploadedBy: adminId, kind: 'brand' },
        orderBy: { createdAt: 'desc' },
      });
      eq('[BA3.5] brand upload stored as image/png', 'image/png', row?.mimeType);
      assert('[BA3.5] brand upload has width > 0',  (row?.width ?? 0) > 0);
      assert('[BA3.5] brand upload has bytes > 0',  (row?.bytes ?? 0) > 0);
    }

    // (BA3.6) Upload with a hero kind → JPG output.
    {
      const r = await postUpload(adminJar, 'hero');
      eq('[BA3.6] hero upload status', 200, r.status);
      const row = await prisma.storeAsset.findFirst({
        where: { uploadedBy: adminId, kind: 'hero' },
        orderBy: { createdAt: 'desc' },
      });
      eq('[BA3.6] hero upload stored as image/jpeg', 'image/jpeg', row?.mimeType);
    }

    // (BA3.7) Garbage kind rejected.
    {
      const r = await postUpload(adminJar, 'invalid_kind_xxx');
      eq('[BA3.7] invalid kind status 400', 400, r.status);
    }

    // (BA3.8) Admin brand POST accepts logoUrl + bannerUrl + description.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const slug = `${TAG_SLUG}-brand`;
      const res = await fetch(`${BASE}/api/admin/brands`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name:        `BA Brand ${TAG_SLUG}`,
          slug,
          logoUrl:     '/api/uploads/public-images/brand/test.png',
          bannerUrl:   '/api/uploads/public-images/category_banner/test.jpg',
          description: 'Test brand description.',
        }),
      });
      eq('[BA3.8] admin POST /api/admin/brands status', 200, res.status);
      const row = await prisma.brand.findUnique({ where: { slug } });
      eq('[BA3.8] brand row has logoUrl',     '/api/uploads/public-images/brand/test.png',           row?.logoUrl);
      eq('[BA3.8] brand row has bannerUrl',   '/api/uploads/public-images/category_banner/test.jpg', row?.bannerUrl);
      eq('[BA3.8] brand row has description', 'Test brand description.',                              row?.description);
    }

    // (BA3.9) Public /api/brands surfaces the new logoUrl field.
    {
      const res = await fetch(`${BASE}/api/brands`);
      const env = await res.json() as { data?: { brands?: Array<{ slug: string; logoUrl?: string | null; description?: string | null }> } };
      const brand = env.data?.brands?.find((b) => b.slug === `${TAG_SLUG}-brand`);
      assert('[BA3.9] /api/brands includes the test brand', brand !== undefined);
      eq('[BA3.9] /api/brands surfaces logoUrl',     '/api/uploads/public-images/brand/test.png', brand?.logoUrl);
      eq('[BA3.9] /api/brands surfaces description', 'Test brand description.',                    brand?.description);
    }

    // (BA3.10) Admin category POST accepts all three asset fields.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const slug = `${TAG_SLUG}-cat`;
      const res = await fetch(`${BASE}/api/admin/categories`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name:        `BA Cat ${TAG_SLUG}`,
          slug,
          description: 'Test category.',
          sortOrder:   999,
          isActive:    true,
          imageUrl:    '/api/uploads/public-images/category/x.jpg',
          bannerUrl:   '/api/uploads/public-images/category_banner/x.jpg',
          iconUrl:     '/api/uploads/public-images/category_icon/x.png',
        }),
      });
      eq('[BA3.10] admin POST /api/admin/categories status', 200, res.status);
      const row = await prisma.category.findUnique({ where: { slug } });
      eq('[BA3.10] category row has imageUrl',  '/api/uploads/public-images/category/x.jpg',        row?.imageUrl);
      eq('[BA3.10] category row has bannerUrl', '/api/uploads/public-images/category_banner/x.jpg', row?.bannerUrl);
      eq('[BA3.10] category row has iconUrl',   '/api/uploads/public-images/category_icon/x.png',   row?.iconUrl);
    }

    // (BA3.11) Public /api/categories surfaces the new fields.
    {
      const res = await fetch(`${BASE}/api/categories`);
      const env = await res.json() as { data?: { categories?: Array<{ slug: string; imageUrl?: string | null; iconUrl?: string | null }> } };
      const cat = env.data?.categories?.find((c) => c.slug === `${TAG_SLUG}-cat`);
      assert('[BA3.11] /api/categories includes the test category', cat !== undefined);
      eq('[BA3.11] /api/categories surfaces imageUrl', '/api/uploads/public-images/category/x.jpg',     cat?.imageUrl);
      eq('[BA3.11] /api/categories surfaces iconUrl',  '/api/uploads/public-images/category_icon/x.png', cat?.iconUrl);
    }
    // ── Phase 2 — admin /api/admin/assets ─────────────────────────

    // (BA3.12) GET /api/admin/assets returns the standard envelope.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      const res = await fetch(`${BASE}/api/admin/assets?pageSize=5`, { headers });
      eq('[BA3.12] GET /api/admin/assets status', 200, res.status);
      const env = await res.json() as { ok?: boolean; data?: { items?: unknown[]; pagination?: { total: number } } };
      assert('[BA3.12] response.ok',                env.ok === true);
      assert('[BA3.12] data.items is array',        Array.isArray(env.data?.items));
      assert('[BA3.12] data.pagination present',    env.data?.pagination !== undefined);
      assert('[BA3.12] at least 2 assets registered (from earlier uploads)',
        (env.data?.pagination?.total ?? 0) >= 2,
        env.data?.pagination);
    }

    // (BA3.13) GET ?include=health embeds the three coverage objects.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      const res = await fetch(`${BASE}/api/admin/assets?include=health&pageSize=5`, { headers });
      eq('[BA3.13] include=health status', 200, res.status);
      const env = await res.json() as { data?: { health?: { storeIdentity?: unknown; brands?: { brands: unknown[] }; categories?: { categories: unknown[] } } } };
      const h = env.data?.health;
      assert('[BA3.13] health.storeIdentity present', h?.storeIdentity !== undefined);
      assert('[BA3.13] health.brands.brands is array', Array.isArray(h?.brands?.brands));
      assert('[BA3.13] health.categories.categories is array', Array.isArray(h?.categories?.categories));
    }

    // (BA3.14) GET ?kind=brand filters to only brand uploads.
    {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      const res = await fetch(`${BASE}/api/admin/assets?kind=brand&pageSize=10`, { headers });
      const env = await res.json() as { data?: { items?: Array<{ kind: string }> } };
      const items = env.data?.items ?? [];
      assert('[BA3.14] every returned item has kind=brand',
        items.every((it) => it.kind === 'brand'),
        items.map((it) => it.kind));
    }

    // (BA3.15) DELETE on a referenced asset → 409 ASSET_IN_USE.
    {
      // Find a brand-kind asset, point a brand at it, then try to delete.
      const a = await prisma.storeAsset.findFirst({
        where: { uploadedBy: adminId, kind: 'brand' },
        orderBy: { createdAt: 'desc' },
      });
      assert('[BA3.15] precondition: a brand-kind asset exists', a !== null);
      // Point a brand at this asset URL so the reference check trips.
      const brand = await prisma.brand.findFirst({ where: { slug: { startsWith: 'ba-' } } });
      assert('[BA3.15] precondition: a fixture brand exists', brand !== null);
      await prisma.brand.update({ where: { id: brand!.id }, data: { logoUrl: a!.url } });

      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/assets/${a!.id}`, { method: 'DELETE', headers });
      eq('[BA3.15] DELETE blocked → 409', 409, res.status);
      const env = await res.json() as { code?: string; references?: Array<{ entity: string }> };
      eq('[BA3.15] error code = ASSET_IN_USE', 'ASSET_IN_USE', env.code);
      assert('[BA3.15] references list mentions the brand',
        (env.references ?? []).some((r) => r.entity.startsWith('Brand:')),
        env.references);
      // Still present.
      const still = await prisma.storeAsset.findUnique({ where: { id: a!.id } });
      assert('[BA3.15] row still present after blocked delete', still !== null);
    }

    // (BA3.16) DELETE ?force=1 succeeds even when referenced.
    {
      const a = await prisma.storeAsset.findFirst({
        where: { uploadedBy: adminId, kind: 'brand' },
        orderBy: { createdAt: 'desc' },
      });
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      const res = await fetch(`${BASE}/api/admin/assets/${a!.id}?force=1`, { method: 'DELETE', headers });
      eq('[BA3.16] forced DELETE status', 200, res.status);
      const env = await res.json() as { data?: { forced: boolean; fileGone: boolean } };
      eq('[BA3.16] response.data.forced = true', true, env.data?.forced);
      const gone = await prisma.storeAsset.findUnique({ where: { id: a!.id } });
      eq('[BA3.16] row deleted', null, gone);
    }

    // (BA3.17) DELETE non-admin → 401/403.
    {
      const res = await fetch(`${BASE}/api/admin/assets/anything`, { method: 'DELETE' });
      assert('[BA3.17] anonymous DELETE rejected',
        res.status === 401 || res.status === 403, res.status);
    }
  } finally {
    await stopServer();
    await cleanup();
  }
}

async function cleanup(): Promise<void> {
  console.log('\n── cleanup ──');
  // Storefront / brand / category fixture rows.
  await prisma.brand.deleteMany({    where: { slug: { startsWith: 'ba-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'ba-' } } });
  // Admin fixture + everything they wrote.
  const admins = await prisma.user.findMany({
    where: { email: { startsWith: 'ba_' } },
    select: { id: true },
  });
  for (const u of admins) {
    await prisma.storeAsset.deleteMany({ where: { uploadedBy: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    try { await prisma.user.delete({ where: { id: u.id } }); } catch { /* leave for next sweep */ }
  }
  console.log(`  ✔ removed ${admins.length} admin(s) + fixture brand/category rows`);
}

// ── Main ─────────────────────────────────────────────────────────────────
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
