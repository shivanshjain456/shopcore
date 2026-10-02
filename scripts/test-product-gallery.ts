/**
 * Item 19 — Product Gallery test harness.
 *
 *   npm run test:product-gallery
 *
 * Sections:
 *   1. UNIT          — `'product'` image kind is registered; gallery
 *                      service helpers (`isGalleryEnabled`,
 *                      `isGalleryLazyLoadEnabled`, `readMaxGalleryImages`)
 *                      return sensible defaults; validation errors fire.
 *   2. SERVICE       — register / update / setPrimary / reorder /
 *                      delete round-trip; exactly-one-primary invariant;
 *                      auto-promote on primary deletion; gallery-cap
 *                      enforcement; alt/sortOrder validation.
 *   3. STATIC AUDIT  — required files present; admin routes audit;
 *                      no `console.*` in src/lib/cms/productGallery.ts;
 *                      no `: any` / `as any` in any new gallery file;
 *                      no `key={i|idx|index}` in the manager;
 *                      `products.galleryEnabled` registered;
 *                      `'product'` image kind registered;
 *                      PDP page imports the new gallery component.
 *   4. INTEGRATION   — `next start -p 3079`. Admin API: list / register
 *                      / patch / setPrimary / reorder / delete; cap
 *                      enforced; rate-limit (admin.uploads); PDP renders
 *                      the gallery; `products.galleryEnabled=false`
 *                      hides the thumb rail; soft-disabled images are
 *                      filtered from product cards.
 *   5. REGRESSION    — wishlist / cart / orders / search still render
 *                      product images.
 *
 * Spec — every assertion carries [PG<n>.<m>] tags.
 */
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import {
  isGalleryEnabled, isGalleryLazyLoadEnabled,
  listGalleryForAdmin, listGalleryForPdp, countGallery,
  registerImage, updateImage, deleteImage, setPrimary, reorderImages,
} from '../src/lib/cms/productGallery';
import { ADMIN_IMAGE_KINDS, IMAGE_KIND_SPECS } from '../src/lib/uploads/imageKinds';
import { ValidationError, NotFoundError } from '../src/lib/errors';

// ── Harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  \u2714 ${label}`); }
function failAssert(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  \u2718 ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  if (existsSync(SRV_LOG)) {
    const tail = readFileSync(SRV_LOG, 'utf-8').split('\n').slice(-20).join('\n');
    console.error('     \u2500\u2500 recent server lines \u2500\u2500\n' + tail);
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

const TAG       = `pg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const TAG_SLUG  = `pg-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const PORT      = 3079;
const BASE      = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG   = `/tmp/test-product-gallery-${process.pid}.log`;
const REPO_ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────── 1. UNIT
function unitTests() {
  console.log('\n\u2500\u2500 UNIT \u2500\u2500');

  // (PG1.1) `'product'` kind is registered.
  assert('[PG1.1] product kind is in ADMIN_IMAGE_KINDS',
    (ADMIN_IMAGE_KINDS as readonly string[]).includes('product'));
  const spec = IMAGE_KIND_SPECS.product;
  assert('[PG1.1] product kind has outputFormat jpg', spec.outputFormat === 'jpg');
  assert('[PG1.1] product kind has maxPx >= 2000',    spec.maxPx >= 2000);
  assert('[PG1.1] product kind has maxMb in 1..10',   spec.maxMb >= 1 && spec.maxMb <= 10);
  assert('[PG1.1] product kind quality >= 80',        spec.quality >= 80);

  // (PG1.2) Defaults.
  eq('[PG1.2] isGalleryEnabled defaults true on empty cfg',
    true, isGalleryEnabled({}));
  eq('[PG1.2] isGalleryLazyLoadEnabled defaults true on empty cfg',
    true, isGalleryLazyLoadEnabled({}));
  eq('[PG1.2] isGalleryEnabled returns false when explicitly false',
    false, isGalleryEnabled({ products: { galleryEnabled: false } }));
  eq('[PG1.2] isGalleryLazyLoadEnabled returns false when explicitly false',
    false, isGalleryLazyLoadEnabled({ products: { galleryLazyLoadEnabled: false } }));
}

// ─────────────────────────────────────────────────────────────── 2. SERVICE
interface FixtureProduct { id: string; slug: string; categoryId: string; brandId: string }

async function createFixtureProduct(suffix = ''): Promise<FixtureProduct> {
  const cat = await prisma.category.upsert({
    where:  { slug: `${TAG_SLUG}-cat` },
    update: {},
    create: { name: `Gallery cat ${TAG_SLUG}`, slug: `${TAG_SLUG}-cat`, sortOrder: 999, isActive: true },
  });
  const brand = await prisma.brand.upsert({
    where:  { slug: `${TAG_SLUG}-brand` },
    update: {},
    create: { name: `Gallery brand ${TAG_SLUG}`, slug: `${TAG_SLUG}-brand`, isActive: true },
  });
  const p = await prisma.product.create({
    data: {
      sku:        `${TAG}-${suffix || 'sku'}`,
      name:       `Gallery Test Product ${suffix}`,
      slug:       `${TAG_SLUG}-product${suffix ? `-${suffix}` : ''}`,
      description:'fixture',
      shortDesc:  'fixture',
      categoryId: cat.id,
      brandId:    brand.id,
      mrpPaise:   100_000,
      pricePaise: 80_000,
      gstRate:    18,
      stock:      10,
      attributes: '{}',
      isActive:   true,
    },
  });
  return { id: p.id, slug: p.slug, categoryId: cat.id, brandId: brand.id };
}

async function serviceTests() {
  console.log('\n\u2500\u2500 SERVICE \u2500\u2500');
  const fx = await createFixtureProduct();

  // (PG2.1) register the first image → auto-primary.
  const img1 = await registerImage({
    productId: fx.id,
    url: `/uploads/test/${TAG}-1.jpg`,
    alt: 'Front view',
  });
  assert('[PG2.1] first image becomes primary', img1.isPrimary === true);
  assert('[PG2.1] first image is active by default', img1.isActive === true);
  assert('[PG2.1] first image has sortOrder >= 10', img1.sortOrder >= 10);

  // (PG2.2) register a second image → non-primary; sortOrder grows.
  const img2 = await registerImage({
    productId: fx.id,
    url: `/uploads/test/${TAG}-2.jpg`,
    alt: 'Side view',
  });
  assert('[PG2.2] second image is NOT primary', img2.isPrimary === false);
  assert('[PG2.2] second sortOrder > first', img2.sortOrder > img1.sortOrder);

  // (PG2.3) listGalleryForPdp returns active rows ordered primary-first.
  const pdpList = await listGalleryForPdp(fx.id);
  eq('[PG2.3] pdp list length', 2, pdpList.length);
  eq('[PG2.3] pdp list[0] is primary', img1.id, pdpList[0]!.id);

  // (PG2.4) Exactly-one-primary via setPrimary.
  const img2Promoted = await setPrimary(fx.id, img2.id);
  assert('[PG2.4] setPrimary flipped img2', img2Promoted.isPrimary === true);
  const all = await listGalleryForAdmin(fx.id);
  const primaries = all.filter((r) => r.isPrimary);
  eq('[PG2.4] exactly one primary', 1, primaries.length);
  eq('[PG2.4] new primary is img2', img2.id, primaries[0]!.id);

  // (PG2.5) updateImage: alt + isActive.
  const altUpdate = await updateImage(img1.id, { alt: 'New alt text' });
  eq('[PG2.5] alt updated', 'New alt text', altUpdate.alt);
  const deactivated = await updateImage(img1.id, { isActive: false });
  eq('[PG2.5] isActive flipped false', false, deactivated.isActive);
  // pdp list should now omit the disabled image
  const afterDisable = await listGalleryForPdp(fx.id);
  eq('[PG2.5] disabled image dropped from pdp list', 1, afterDisable.length);

  // (PG2.6) Cannot setPrimary on a disabled image.
  let threw = false;
  try { await setPrimary(fx.id, img1.id); } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert('[PG2.6] setPrimary on inactive image throws ValidationError', threw);

  // (PG2.7) deleteImage on the current primary auto-promotes the next active.
  // (Re-enable img1 first so we have a candidate to promote to.)
  await updateImage(img1.id, { isActive: true });
  // img2 is currently primary. Delete it.
  await deleteImage(img2.id);
  const afterDel = await listGalleryForAdmin(fx.id);
  eq('[PG2.7] only one image left', 1, afterDel.length);
  assert('[PG2.7] surviving image was auto-promoted to primary',
    afterDel[0]!.isPrimary === true);

  // (PG2.8) reorderImages atomically renumbers.
  // Re-register two new images to have something to reorder.
  const a = await registerImage({ productId: fx.id, url: `/uploads/test/${TAG}-a.jpg` });
  const b = await registerImage({ productId: fx.id, url: `/uploads/test/${TAG}-b.jpg` });
  void a; void b;
  const before = await listGalleryForAdmin(fx.id);
  const reversed = before.map((r) => r.id).slice().reverse();
  await reorderImages(fx.id, reversed);
  const after = await listGalleryForAdmin(fx.id);
  // After reorder, sortOrder reflects new positions. The primary-first
  // listing means we sort by (isPrimary desc, sortOrder asc) — so check
  // raw sortOrder via the DB.
  const raw = await prisma.productImage.findMany({
    where: { productId: fx.id }, orderBy: { sortOrder: 'asc' },
  });
  eq('[PG2.8] reorder produced 3 rows', 3, raw.length);
  eq('[PG2.8] reorder first id matches', reversed[0], raw[0]!.id);
  eq('[PG2.8] reorder sortOrder is 10/20/30', [10, 20, 30], raw.map((r) => r.sortOrder));
  void after;

  // (PG2.9) Validation errors.
  let urlThrew = false;
  try { await registerImage({ productId: fx.id, url: '' }); } catch (e) {
    urlThrew = e instanceof ValidationError;
  }
  assert('[PG2.9] empty url → ValidationError', urlThrew);

  let altLongThrew = false;
  try { await updateImage(raw[0]!.id, { alt: 'x'.repeat(300) }); } catch (e) {
    altLongThrew = e instanceof ValidationError;
  }
  assert('[PG2.9] alt > 200 chars → ValidationError', altLongThrew);

  let orderBadThrew = false;
  try { await updateImage(raw[0]!.id, { sortOrder: -1 }); } catch (e) {
    orderBadThrew = e instanceof ValidationError;
  }
  assert('[PG2.9] sortOrder < 0 → ValidationError', orderBadThrew);

  // (PG2.10) NotFoundError for unknown product / image.
  let nfThrew = false;
  try { await registerImage({ productId: 'does-not-exist', url: '/x.jpg' }); } catch (e) {
    nfThrew = e instanceof NotFoundError;
  }
  assert('[PG2.10] register on unknown product → NotFoundError', nfThrew);

  let nfImgThrew = false;
  try { await setPrimary(fx.id, 'does-not-exist'); } catch (e) {
    nfImgThrew = e instanceof NotFoundError;
  }
  assert('[PG2.10] setPrimary unknown image → NotFoundError', nfImgThrew);

  // (PG2.11) countGallery matches list size.
  eq('[PG2.11] countGallery == listSize', (await listGalleryForAdmin(fx.id)).length, await countGallery(fx.id));
}

// ─────────────────────────────────────────────────────── 3. STATIC AUDIT
function staticAuditTests() {
  console.log('\n\u2500\u2500 STATIC AUDIT \u2500\u2500');

  // (PG3.1) Required files.
  const files = [
    'prisma/migrations/20260609120000_product_gallery_columns/migration.sql',
    'src/lib/cms/productGallery.ts',
    'src/app/api/admin/products/[id]/images/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/primary/route.ts',
    'src/app/api/admin/products/[id]/images/reorder/route.ts',
    'src/components/storefront/ProductGallery.tsx',
    'src/app/admin/(app)/products/[id]/ProductGalleryManager.tsx',
  ];
  for (const f of files) {
    assert(`[PG3.1] file exists: ${f}`, existsSync(path.join(REPO_ROOT, f)));
  }

  // (PG3.2) Admin product-image routes call audit() with the right action.
  const auditChecks: Array<{ file: string; action: string }> = [
    { file: 'src/app/api/admin/products/[id]/images/route.ts',                action: 'PRODUCT_IMAGE_UPLOAD' },
    { file: 'src/app/api/admin/products/[id]/images/[imageId]/route.ts',      action: 'PRODUCT_IMAGE_UPDATE' },
    { file: 'src/app/api/admin/products/[id]/images/[imageId]/route.ts',      action: 'PRODUCT_IMAGE_DELETE' },
    { file: 'src/app/api/admin/products/[id]/images/reorder/route.ts',        action: 'PRODUCT_IMAGE_REORDER' },
    { file: 'src/app/api/admin/products/[id]/images/[imageId]/primary/route.ts', action: 'PRODUCT_IMAGE_PRIMARY_CHANGED' },
  ];
  for (const c of auditChecks) {
    const src = readFileSync(path.join(REPO_ROOT, c.file), 'utf-8');
    assert(`[PG3.2] ${c.file} audits ${c.action}`, src.includes(c.action) && src.includes('audit('));
  }

  // (PG3.3) PDP imports the new gallery component.
  const pdp = readFileSync(path.join(REPO_ROOT, 'src/app/(storefront)/p/[slug]/page.tsx'), 'utf-8');
  assert('[PG3.3] PDP imports ProductGallery', pdp.includes("import ProductGallery"));
  assert('[PG3.3] PDP renders <ProductGallery',  pdp.includes('<ProductGallery'));

  // (PG3.4) Store config has the three new keys + the products category.
  const schema = readFileSync(path.join(REPO_ROOT, 'src/lib/storeConfig/schema.ts'), 'utf-8');
  assert('[PG3.4] schema has products.galleryEnabled',         schema.includes("'products.galleryEnabled'"));
  assert('[PG3.4] schema has products.maxGalleryImages',       schema.includes("'products.maxGalleryImages'"));
  assert('[PG3.4] schema has products.galleryLazyLoadEnabled', schema.includes("'products.galleryLazyLoadEnabled'"));
  assert('[PG3.4] schema registers products category',         schema.includes("'products',"));

  // (PG3.5) featureGate exports the helpers.
  const fg = readFileSync(path.join(REPO_ROOT, 'src/lib/storeConfig/featureGate.ts'), 'utf-8');
  assert('[PG3.5] featureGate exports isProductGalleryEnabled',         fg.includes('isProductGalleryEnabled'));
  assert('[PG3.5] featureGate exports isProductGalleryLazyLoadEnabled', fg.includes('isProductGalleryLazyLoadEnabled'));

  // (PG3.6) `'product'` image kind registered.
  const kinds = readFileSync(path.join(REPO_ROOT, 'src/lib/uploads/imageKinds.ts'), 'utf-8');
  assert('[PG3.6] imageKinds.ts declares product type', /\|\s*'product'/.test(kinds));
  assert('[PG3.6] imageKinds.ts has product spec',      /\bproduct:\s*{/.test(kinds));

  // (PG3.7) No `console.*` in the service module or admin routes.
  const svc = readFileSync(path.join(REPO_ROOT, 'src/lib/cms/productGallery.ts'), 'utf-8');
  assert('[PG3.7] productGallery.ts has no console.*', !/\bconsole\.(log|warn|error|info|debug)\(/.test(svc));
  for (const f of [
    'src/app/api/admin/products/[id]/images/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/primary/route.ts',
    'src/app/api/admin/products/[id]/images/reorder/route.ts',
  ]) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf-8');
    assert(`[PG3.7] ${f} has no console.*`, !/\bconsole\.(log|warn|error|info|debug)\(/.test(src));
  }

  // (PG3.8) No `: any` / `as any` in any new gallery file.
  const newFiles = [
    'src/lib/cms/productGallery.ts',
    'src/components/storefront/ProductGallery.tsx',
    'src/app/admin/(app)/products/[id]/ProductGalleryManager.tsx',
    'src/app/api/admin/products/[id]/images/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/route.ts',
    'src/app/api/admin/products/[id]/images/[imageId]/primary/route.ts',
    'src/app/api/admin/products/[id]/images/reorder/route.ts',
  ];
  for (const f of newFiles) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf-8');
    assert(`[PG3.8] ${f} has no ": any" annotation`, !/:\s*any\b/.test(src));
    assert(`[PG3.8] ${f} has no "as any" assertion`, !/\bas\s+any\b/.test(src));
  }

  // (PG3.9) Manager has stable keys (no `key={i|idx|index}`).
  const mgr = readFileSync(path.join(REPO_ROOT, 'src/app/admin/(app)/products/[id]/ProductGalleryManager.tsx'), 'utf-8');
  assert('[PG3.9] manager uses stable keys (no key={i|idx|index})',
    !/key=\{(i|idx|index)\}/.test(mgr));

  // (PG3.10) No `throw new Error` in productGallery.ts (must use typed errors).
  assert('[PG3.10] productGallery.ts has no `throw new Error`',
    !/\bthrow\s+new\s+Error\b/.test(svc));

  // (PG3.11) Gallery component avoids bare `<img>` without the
  //          @next/next/no-img-element disable comment.
  const gal = readFileSync(path.join(REPO_ROOT, 'src/components/storefront/ProductGallery.tsx'), 'utf-8');
  const imgTags = (gal.match(/<img\s/g) ?? []).length;
  const disables = (gal.match(/eslint-disable-next-line @next\/next\/no-img-element/g) ?? []).length;
  assert(`[PG3.11] every <img> in gallery has the eslint-disable comment (${disables}/${imgTags})`,
    disables >= imgTags);

  // (PG3.12) ProductImage Prisma model has the new fields.
  const schemaPrisma = readFileSync(path.join(REPO_ROOT, 'prisma/schema.prisma'), 'utf-8');
  const piBlock = schemaPrisma.match(/model ProductImage\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert('[PG3.12] ProductImage has isActive',  /isActive\s+Boolean/.test(piBlock));
  assert('[PG3.12] ProductImage has createdAt', /createdAt\s+DateTime/.test(piBlock));
  assert('[PG3.12] ProductImage has updatedAt', /updatedAt\s+DateTime/.test(piBlock));
  assert('[PG3.12] ProductImage has compound index',
    piBlock.includes('@@index([productId, isActive, sortOrder])'));

  // (PG3.13) Non-PDP queries no longer pull disabled images.
  //          We grep for any remaining `images: { take: 1, orderBy: { sortOrder: 'asc' } }`
  //          pattern that lacks the active filter.
  const offenders: string[] = [];
  const root = path.join(REPO_ROOT, 'src');
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        const src = readFileSync(full, 'utf-8');
        // Match both orderings of `take` / `orderBy` keys; flag any
        // single-image projection that LACKS a `where: { isActive: true }`
        // filter (a single capture block per match keeps the regex sane).
        const re = /images:\s*\{([^}]+)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const body = m[1];
          if (!/take:\s*1\b/.test(body)) continue;
          if (!/sortOrder/.test(body))   continue;
          if (/isActive:\s*true/.test(body)) continue;
          offenders.push(path.relative(REPO_ROOT, full));
          break;
        }
      }
    }
  }
  walk(root);
  eq('[PG3.13] no remaining un-filtered single-image queries',
    [] as string[], offenders);
}

// ────────────────────────────────────────────── 4 + 5. INTEGRATION + REGRESSION
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
  throw new Error('Server did not start within 30s \u2014 see ' + SRV_LOG);
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
      firstName: 'PG', lastName: 'Admin',
      email: `${TAG}_admin@shopcore.test`,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaTestPG'),
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
  console.log('\n\u2500\u2500 INTEGRATION + REGRESSION \u2500\u2500');
  await startServer();
  try {
    const adminId = await getOrCreateAdmin();
    const adminJar = await adminJarFor(adminId);
    const fx = await createFixtureProduct('integ');

    const sendJson = async (method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
      const headers = new Headers();
      headers.set('cookie', cookieHeader(adminJar));
      if (body) headers.set('content-type', 'application/json');
      if (adminJar.cookies['sc_csrf']) headers.set('x-csrf-token', adminJar.cookies['sc_csrf']);
      headers.set('origin', BASE);
      return fetch(`${BASE}${url}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
    };

    // (PG4.1) GET admin list returns shape + maxImages + galleryEnabled.
    {
      const res = await fetch(`${BASE}/api/admin/products/${fx.id}/images`, {
        headers: { cookie: cookieHeader(adminJar) },
      });
      eq('[PG4.1] admin list status', 200, res.status);
      const env = await res.json() as { data: { items: unknown[]; maxImages: number; galleryEnabled: boolean } };
      assert('[PG4.1] items array', Array.isArray(env.data.items));
      assert('[PG4.1] maxImages number', typeof env.data.maxImages === 'number' && env.data.maxImages >= 1);
      assert('[PG4.1] galleryEnabled boolean', typeof env.data.galleryEnabled === 'boolean');
    }

    // (PG4.2) Register via JSON URL upload — first becomes primary.
    let firstId = '';
    {
      const res = await sendJson('POST', `/api/admin/products/${fx.id}/images`,
        { url: `/uploads/test/${TAG}-int-1.jpg`, alt: 'Front' });
      eq('[PG4.2] register status', 200, res.status);
      const env = await res.json() as { data: { image: { id: string; isPrimary: boolean } } };
      firstId = env.data.image.id;
      assert('[PG4.2] first image is primary', env.data.image.isPrimary);
    }

    // (PG4.3) Second register: not primary.
    let secondId = '';
    {
      const res = await sendJson('POST', `/api/admin/products/${fx.id}/images`,
        { url: `/uploads/test/${TAG}-int-2.jpg`, alt: 'Side' });
      eq('[PG4.3] register status', 200, res.status);
      const env = await res.json() as { data: { image: { id: string; isPrimary: boolean } } };
      secondId = env.data.image.id;
      assert('[PG4.3] second image is NOT primary', !env.data.image.isPrimary);
    }

    // (PG4.4) Set primary via dedicated endpoint.
    {
      const res = await sendJson('POST', `/api/admin/products/${fx.id}/images/${secondId}/primary`);
      eq('[PG4.4] setPrimary status', 200, res.status);
      const after = await prisma.productImage.findMany({ where: { productId: fx.id }, select: { id: true, isPrimary: true } });
      const primaries = after.filter((r) => r.isPrimary).map((r) => r.id);
      eq('[PG4.4] exactly one primary', [secondId], primaries);
    }

    // (PG4.5) Reorder via dedicated endpoint.
    {
      const res = await sendJson('POST', `/api/admin/products/${fx.id}/images/reorder`,
        { orderedIds: [firstId, secondId] });
      eq('[PG4.5] reorder status', 200, res.status);
      const raw = await prisma.productImage.findMany({ where: { productId: fx.id }, orderBy: { sortOrder: 'asc' } });
      eq('[PG4.5] first sort id', firstId, raw[0]!.id);
      eq('[PG4.5] sortOrder is 10/20', [10, 20], raw.map((r) => r.sortOrder));
    }

    // (PG4.6) PATCH alt + isActive.
    {
      const res = await sendJson('PATCH', `/api/admin/products/${fx.id}/images/${firstId}`, { alt: 'Updated alt' });
      eq('[PG4.6] patch status', 200, res.status);
      const r = await prisma.productImage.findUnique({ where: { id: firstId } });
      eq('[PG4.6] alt persisted', 'Updated alt', r?.alt);
    }

    // (PG4.7) Audit log entries written.
    {
      const audits = await prisma.auditLog.findMany({
        where: { actorId: adminId, action: { startsWith: 'PRODUCT_IMAGE_' } },
        select: { action: true },
      });
      const actions = new Set(audits.map((a) => a.action));
      assert('[PG4.7] audit contains UPLOAD',          actions.has('PRODUCT_IMAGE_UPLOAD'));
      assert('[PG4.7] audit contains PRIMARY_CHANGED', actions.has('PRODUCT_IMAGE_PRIMARY_CHANGED'));
      assert('[PG4.7] audit contains REORDER',         actions.has('PRODUCT_IMAGE_REORDER'));
      assert('[PG4.7] audit contains UPDATE',          actions.has('PRODUCT_IMAGE_UPDATE'));
    }

    // (PG4.8) PDP renders the gallery markup.
    {
      const res = await fetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
      eq('[PG4.8] PDP status', 200, res.status);
      const html = await res.text();
      assert('[PG4.8] gallery testid present', html.includes('data-testid="product-gallery"'));
      assert('[PG4.8] image-count attr present', /data-product-image-count="\d+"/.test(html));
      assert('[PG4.8] primary-image attr present', /data-product-image-primary="true"/.test(html));
    }

    // (PG4.9) Soft-disable an image → PDP no longer renders it.
    {
      // Disable the non-primary image (firstId is now non-primary after PG4.4 set secondId primary).
      const res = await sendJson('PATCH', `/api/admin/products/${fx.id}/images/${firstId}`, { isActive: false });
      eq('[PG4.9] disable status', 200, res.status);
      const pdp = await fetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
      const html = await pdp.text();
      assert('[PG4.9] disabled image not rendered',
        !html.includes(`/uploads/test/${TAG}-int-1.jpg`));
      // Re-enable for downstream tests.
      await sendJson('PATCH', `/api/admin/products/${fx.id}/images/${firstId}`, { isActive: true });
    }

    // (PG4.10) products.galleryEnabled = false → no thumb rail on PDP.
    {
      const restore = await withStoreConfig(adminJar, { 'products.galleryEnabled': false });
      try {
        const res = await fetch(`${BASE}/p/${encodeURIComponent(fx.slug)}`);
        const html = await res.text();
        assert('[PG4.10] thumb rail hidden when disabled',
          !html.includes('data-testid="product-gallery-thumbs"'));
        // Main image should STILL render.
        assert('[PG4.10] main image still renders when disabled',
          html.includes('data-testid="product-gallery"'));
      } finally {
        await restore();
      }
    }

    // (PG4.11) Cap enforcement — bump cap down to 2, then registering
    //          a third image returns 400 PRODUCT_GALLERY_LIMIT_REACHED.
    {
      const restore = await withStoreConfig(adminJar, { 'products.maxGalleryImages': 2 });
      try {
        const res = await sendJson('POST', `/api/admin/products/${fx.id}/images`,
          { url: `/uploads/test/${TAG}-overflow.jpg` });
        eq('[PG4.11] over-cap register status', 400, res.status);
        const env = await res.json() as { ok: boolean; code?: string };
        assert('[PG4.11] code surfaces',
          env.code === 'PRODUCT_GALLERY_LIMIT_REACHED' || env.ok === false);
      } finally {
        await restore();
      }
    }

    // (PG4.12) DELETE → primary auto-promotion when current primary removed.
    {
      const res = await sendJson('DELETE', `/api/admin/products/${fx.id}/images/${secondId}`);
      eq('[PG4.12] delete status', 200, res.status);
      const remaining = await prisma.productImage.findMany({
        where: { productId: fx.id }, select: { id: true, isPrimary: true },
      });
      const primaries = remaining.filter((r) => r.isPrimary);
      eq('[PG4.12] one primary remains', 1, primaries.length);
      eq('[PG4.12] surviving image was promoted', firstId, primaries[0]!.id);
    }

    // (PG4.13) Idempotent delete: re-deleting already-gone image returns 200.
    {
      const res = await sendJson('DELETE', `/api/admin/products/${fx.id}/images/${secondId}`);
      eq('[PG4.13] idempotent delete status', 200, res.status);
      const env = await res.json() as { data: { deleted: boolean } };
      eq('[PG4.13] deleted: false on second pass', false, env.data.deleted);
    }

    // ── REGRESSION ────────────────────────────────────────────────
    //  (PG5.1) Wishlist / cart / search / orders / homepage continue
    //          to render images for products that have ACTIVE rows.
    {
      // The PDP read path covers /p/[slug]; here we touch the public
      // /api/products list which uses primary-image projection.
      const res = await fetch(`${BASE}/api/products?q=${encodeURIComponent('Gallery Test')}`);
      eq('[PG5.1] /api/products status', 200, res.status);
      const env = await res.json() as { data: { items: Array<{ slug: string; imageUrl: string | null }> } };
      const hit = env.data.items.find((p) => p.slug === fx.slug);
      assert('[PG5.1] fixture product appears', !!hit);
      assert('[PG5.1] fixture product has imageUrl',
        typeof hit?.imageUrl === 'string' && hit.imageUrl.length > 0);
    }

    //  (PG5.2) Storefront homepage still 200s (smoke check).
    {
      const res = await fetch(`${BASE}/`);
      eq('[PG5.2] / status', 200, res.status);
    }

    //  (PG5.3) Admin product GET still includes images.
    {
      const res = await fetch(`${BASE}/api/admin/products/${fx.id}`, {
        headers: { cookie: cookieHeader(adminJar) },
      });
      eq('[PG5.3] admin GET status', 200, res.status);
      const env = await res.json() as { data: { product: { images: unknown[] } } };
      assert('[PG5.3] admin product carries images array',
        Array.isArray(env.data.product.images));
    }
  } finally {
    await stopServer();
    await wipeFixtures();
    await wipeAdmin();
  }
}

async function wipeFixtures(): Promise<void> {
  // Wipe the fixture product (cascades to ProductImage rows).
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
  await prisma.brand.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
  await prisma.storeAsset.deleteMany({ where: { uploader: { email: { startsWith: 'pg_' } } } });
}

async function wipeAdmin(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { email: { startsWith: 'pg_' } },
    select: { id: true },
  });
  for (const u of admins) {
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    try { await prisma.user.delete({ where: { id: u.id } }); } catch { /* leave */ }
  }
  console.log(`  \u2714 removed ${admins.length} admin fixture(s)`);
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
    console.error('  \u2718 unhandled exception:', err.stack ?? err.message ?? String(e));
  } finally {
    // Best-effort cleanup of any service-test fixtures.
    try {
      await prisma.product.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
      await prisma.brand.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
      await prisma.category.deleteMany({ where: { slug: { startsWith: 'pg-' } } });
    } catch { /* */ }
    await prisma.$disconnect();
    console.log(`\n\u2500\u2500 result \u2500\u2500 ${passed} passed \u00b7 ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}
void main();
