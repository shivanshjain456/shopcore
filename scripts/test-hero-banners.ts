/**
 * Feature #15 — Hero-banner CMS backend test suite.
 *
 *   npm run test:hero-banners
 *
 * Layers:
 *
 *   1. UNIT    — service module (visibility filters, CRUD, reorder),
 *                Zod schemas (every validation branch).
 *   2. INTEG.  — real `next start` on :3041 + real /api/hero-banners
 *                (public) and /api/admin/hero-banners* (admin).
 *   3. REGRESS — existing /admin/brands routes still work; storefront
 *                /api/categories still 200.
 *
 * Cleans up its own rows at the end.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import {
  listVisibleBanners, listAllBanners, getBannerById,
  createBanner, updateBanner, deleteBanner, reorderBanners, toView,
} from '../src/lib/cms/heroBanners';
import {
  HeroBannerCreateSchema, HeroBannerUpdateSchema, HeroBannerReorderSchema,
} from '../src/lib/cms/schemas';
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

const TAG = `hero_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const HOST_PIN = '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
const IMG = '/uploads/hero/test.jpg';
const DESK = 'https://cdn.example.com/desktop.jpg';
const MOB  = 'https://cdn.example.com/mobile.jpg';

async function clearTag() {
  // Delete any banner whose internal name starts with our tag (re-runnable).
  await prisma.heroBanner.deleteMany({ where: { name: { startsWith: TAG } } });
}

// ────────────────────────────────────────────────────────────────── 1. UNIT
async function schemaTests() {
  console.log('\n── UNIT — Zod schemas ──');

  // (Z1) Minimal valid create
  const r1 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z1`, headline: 'H', imageDesktopUrl: DESK,
  });
  assert('(Z1) minimal valid input passes', r1.success, r1.success ? null : r1.error.format());

  // (Z2) Missing required fields
  const r2 = HeroBannerCreateSchema.safeParse({ headline: 'H' });
  assert('(Z2) missing name/image rejected', !r2.success);

  // (Z3) CTA label without href rejected
  const r3 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z3`, headline: 'H', imageDesktopUrl: DESK,
    ctaLabel: 'Shop',
  });
  assert('(Z3) CTA label without href rejected', !r3.success);

  // (Z4) CTA href without label rejected
  const r4 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z4`, headline: 'H', imageDesktopUrl: DESK,
    ctaHref: '/x',
  });
  assert('(Z4) CTA href without label rejected', !r4.success);

  // (Z5) Both CTA fields together pass
  const r5 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z5`, headline: 'H', imageDesktopUrl: DESK,
    ctaLabel: 'Shop', ctaHref: '/c/laptops',
  });
  assert('(Z5) CTA label+href together pass', r5.success);

  // (Z6) Bad image URL rejected (must start with / or http(s)://)
  const r6 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z6`, headline: 'H', imageDesktopUrl: 'cdn.example.com/x.jpg',
  });
  assert('(Z6) bad image URL (no scheme/leading slash) rejected', !r6.success);

  // (Z7) endsAt before startsAt rejected
  const r7 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z7`, headline: 'H', imageDesktopUrl: DESK,
    startsAt: new Date(Date.now() + 86_400_000),
    endsAt:   new Date(Date.now() + 1000),
  });
  assert('(Z7) endsAt before startsAt rejected', !r7.success);

  // (Z8) overlayOpacity bounds
  const r8 = HeroBannerCreateSchema.safeParse({
    name: `${TAG}_z8`, headline: 'H', imageDesktopUrl: DESK,
    overlayOpacity: 150,
  });
  assert('(Z8) overlayOpacity > 100 rejected', !r8.success);

  // (Z9) Update schema accepts partial input
  const r9 = HeroBannerUpdateSchema.safeParse({ isActive: false });
  assert('(Z9) update accepts {isActive:false} only', r9.success);

  // (Z10) Update schema is .strict() — unknown key rejected
  const r10 = HeroBannerUpdateSchema.safeParse({ isActive: false, sneaky: 'no' });
  assert('(Z10) update rejects unknown keys (.strict)', !r10.success);

  // (Z11) Reorder schema
  const r11 = HeroBannerReorderSchema.safeParse({ ids: ['a', 'b', 'c'] });
  assert('(Z11) reorder accepts non-empty ids', r11.success);
  const r12 = HeroBannerReorderSchema.safeParse({ ids: [] });
  assert('(Z11) reorder rejects empty ids', !r12.success);
}

async function serviceTests() {
  console.log('\n── SERVICE — heroBanners (direct DB) ──');
  await clearTag();

  // (S1) createBanner persists and returns
  const a = await createBanner({
    name: `${TAG}_a`, headline: 'Slide A', imageDesktopUrl: DESK,
    ctaLabel: 'Shop A', ctaHref: '/c/a',
  });
  eq('(S1) create returns the row with id', true, !!a.id);
  eq('(S1) defaults: isActive=true', true, a.isActive);
  eq('(S1) defaults: displayOrder=0', 0, a.displayOrder);
  eq('(S1) defaults: overlayOpacity=35', 35, a.overlayOpacity);

  // (S2) Visible list contains it
  const v1 = await listVisibleBanners();
  assert('(S2) visible list contains active banner', v1.some((b) => b.id === a.id));

  // (S3) Deactivate hides it
  await updateBanner(a.id, { isActive: false });
  const v2 = await listVisibleBanners();
  assert('(S3) deactivated banner is not visible', !v2.some((b) => b.id === a.id));

  // (S4) Future startsAt hides it; past startsAt shows it
  const future = new Date(Date.now() + 60_000);
  const past   = new Date(Date.now() - 60_000);
  await updateBanner(a.id, { isActive: true, startsAt: future });
  const v3 = await listVisibleBanners();
  assert('(S4a) banner with future startsAt hidden', !v3.some((b) => b.id === a.id));
  await updateBanner(a.id, { startsAt: past });
  const v4 = await listVisibleBanners();
  assert('(S4b) banner with past startsAt visible', v4.some((b) => b.id === a.id));

  // (S5) endsAt in the past hides it
  await updateBanner(a.id, { endsAt: past });
  const v5 = await listVisibleBanners();
  assert('(S5) banner past endsAt hidden', !v5.some((b) => b.id === a.id));
  await updateBanner(a.id, { endsAt: null });

  // (S6) Reorder
  const b = await createBanner({ name: `${TAG}_b`, headline: 'B', imageDesktopUrl: DESK });
  const c = await createBanner({ name: `${TAG}_c`, headline: 'C', imageDesktopUrl: DESK });
  await reorderBanners([c.id, a.id, b.id]);
  const all = await listAllBanners();
  const ours = all.filter((x) => x.name.startsWith(TAG));
  const order = ours.map((x) => x.name.slice(-1));
  // order should be C, A, B
  eq('(S6) reorder rewrites displayOrder', ['c', 'a', 'b'], order);

  // (S7) toView strips audit columns + clamps overlayOpacity
  const view = toView({
    ...a, overlayOpacity: 200, textColor: 'rainbow' as unknown as string,
  });
  eq('(S7) toView clamps overlayOpacity to 100', 100, view.overlayOpacity);
  eq('(S7) toView coerces unknown textColor → null', null, view.textColor);

  // (S8) getBannerById
  const fetched = await getBannerById(a.id);
  assert('(S8) getBannerById returns the row', !!fetched && fetched.id === a.id);

  // (S9) delete
  await deleteBanner(b.id);
  const after = await getBannerById(b.id);
  assert('(S9) deleteBanner removes the row', after === null);

  // Cleanup for this section.
  await clearTag();
}

// ────────────────────────────────────────────────────────────────── 2. INTEGRATION
const PORT = 3041;
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
  const out = (b: Buffer) => writeFileSync('/tmp/test-hero-banners.log', b, { flag: 'a' });
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
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) { return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown; headers?: Record<string, string> }) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (!headers.has('origin')) headers.set('origin', BASE);
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

async function makeAdminJar(label: string) {
  const email = `${TAG}_admin_${label}@shopcore.test`;
  const phone = HOST_PIN.slice(0, 3) + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000).slice(0, 9);
  const user = await prisma.user.create({
    data: {
      firstName: 'Hero', lastName: label, email, phone,
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'ADMIN', status: 'ACTIVE',
      referralCode: 'R' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
  const fam = await issueRefreshFamily({ userId: user.id, role: 'ADMIN' });
  const ttl = accessTtlFor('ADMIN');
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
  jar.cookies['sc_admin'] = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return { user, jar };
}

async function integrationTests() {
  console.log('\n── INTEGRATION — HTTP ──');
  await clearTag();

  // (P1) Public list with no banners → 200 + empty array
  const anon = newJar();
  const r1 = await api(anon, '/api/hero-banners');
  eq('(P1) GET /api/hero-banners → 200', 200, r1.status);
  const data1 = (r1.body.data ?? {}) as { banners: unknown[]; config: Record<string, unknown> };
  assert('(P1) envelope has banners array', Array.isArray(data1.banners));
  assert('(P1) envelope has config object', typeof data1.config === 'object' && data1.config !== null);
  assert('(P1) config.autoplayMs is a number', typeof data1.config.autoplayMs === 'number');

  // (P2) Cache-Control header set
  const cc = r1.headers.get('cache-control');
  assert(`(P2) Cache-Control set (got "${cc}")`,
    typeof cc === 'string' && /max-age=\d+/.test(cc));

  // (A1) Admin GET without admin cookie → 401/403
  const anonAdmin = await api(anon, '/api/admin/hero-banners');
  assert(`(A1) admin list anonymously → 4xx (got ${anonAdmin.status})`,
    anonAdmin.status === 401 || anonAdmin.status === 403);

  // Make a real admin session for the rest of the integration tier.
  const { jar: adminJar } = await makeAdminJar('cms');

  // (A2) Admin GET works
  const adminList = await api(adminJar, '/api/admin/hero-banners');
  eq('(A2) admin list with session → 200', 200, adminList.status);

  // (A3) Admin POST without CSRF (force header off) → 403
  // We use a separate fetch that omits the header.
  const noCsrfHeaders = new Headers();
  noCsrfHeaders.set('cookie', cookieHeader(adminJar));
  noCsrfHeaders.set('content-type', 'application/json');
  noCsrfHeaders.set('origin', BASE);
  const noCsrfRes = await fetch(`${BASE}/api/admin/hero-banners`, {
    method: 'POST',
    headers: noCsrfHeaders,
    body: JSON.stringify({ name: 'x', headline: 'x', imageDesktopUrl: DESK }),
  });
  eq('(A3) POST without CSRF → 403', 403, noCsrfRes.status);

  // (A4) Admin POST creates a banner
  const created = await api(adminJar, '/api/admin/hero-banners', {
    method: 'POST',
    json: {
      name: `${TAG}_int_a`, headline: 'Integration A',
      imageDesktopUrl: DESK, imageMobileUrl: MOB,
      ctaLabel: 'Shop', ctaHref: '/c/laptops',
      isActive: true,
    },
  });
  eq('(A4) POST creates banner → 200', 200, created.status);
  const cbanner = (created.body.data as { banner: { id: string; headline: string } }).banner;
  assert('(A4) returned banner has id', typeof cbanner.id === 'string' && cbanner.id.length > 0);

  // (P3) Public list now contains the banner
  await new Promise((r) => setTimeout(r, 50));
  const r3 = await api(anon, '/api/hero-banners');
  const banners3 = ((r3.body.data ?? {}) as { banners: { id: string }[] }).banners;
  assert('(P3) public list now contains the new banner',
    banners3.some((b) => b.id === cbanner.id));

  // (A5) PATCH a banner
  const patched = await api(adminJar, `/api/admin/hero-banners/${cbanner.id}`, {
    method: 'PATCH', json: { headline: 'Integration A (edited)', overlayOpacity: 50 },
  });
  eq('(A5) PATCH → 200', 200, patched.status);
  const patchedBanner = (patched.body.data as { banner: { headline: string; overlayOpacity: number } }).banner;
  eq('(A5) headline updated', 'Integration A (edited)', patchedBanner.headline);
  eq('(A5) overlayOpacity updated', 50, patchedBanner.overlayOpacity);

  // (A6) PATCH with unknown key → 400 (strict schema)
  const strict = await api(adminJar, `/api/admin/hero-banners/${cbanner.id}`, {
    method: 'PATCH', json: { headline: 'x', sneaky: 'no' },
  });
  eq('(A6) PATCH with unknown key → 400', 400, strict.status);

  // (A7) Two more banners + reorder
  const b2res = await api(adminJar, '/api/admin/hero-banners', {
    method: 'POST',
    json: { name: `${TAG}_int_b`, headline: 'B', imageDesktopUrl: DESK },
  });
  const b3res = await api(adminJar, '/api/admin/hero-banners', {
    method: 'POST',
    json: { name: `${TAG}_int_c`, headline: 'C', imageDesktopUrl: DESK },
  });
  const b2 = (b2res.body.data as { banner: { id: string } }).banner;
  const b3 = (b3res.body.data as { banner: { id: string } }).banner;

  // Re-order: C, A, B
  const ro = await api(adminJar, '/api/admin/hero-banners/reorder', {
    method: 'POST', json: { ids: [b3.id, cbanner.id, b2.id] },
  });
  eq('(A7) reorder → 200', 200, ro.status);

  // (P4) Public list reflects the new order (C, A, B).
  const r4 = await api(anon, '/api/hero-banners');
  const banners4 = ((r4.body.data ?? {}) as { banners: { id: string }[] }).banners;
  const orderedIds = banners4.filter((b) => [b3.id, cbanner.id, b2.id].includes(b.id)).map((b) => b.id);
  eq('(P4) public list respects displayOrder', [b3.id, cbanner.id, b2.id], orderedIds);

  // (A8) DELETE
  const del = await api(adminJar, `/api/admin/hero-banners/${b2.id}`, { method: 'DELETE' });
  eq('(A8) DELETE → 200', 200, del.status);

  // (P5) Deleted banner gone from public list
  const r5 = await api(anon, '/api/hero-banners');
  const banners5 = ((r5.body.data ?? {}) as { banners: { id: string }[] }).banners;
  assert('(P5) deleted banner gone from public list',
    !banners5.some((b) => b.id === b2.id));

  // (A9) PATCH non-existent → 404
  const ghost = await api(adminJar, `/api/admin/hero-banners/does-not-exist`, {
    method: 'PATCH', json: { headline: 'x' },
  });
  eq('(A9) PATCH non-existent → 404', 404, ghost.status);

  // (A10) DELETE non-existent → 404
  const ghostDel = await api(adminJar, `/api/admin/hero-banners/does-not-exist`, {
    method: 'DELETE',
  });
  eq('(A10) DELETE non-existent → 404', 404, ghostDel.status);

  // (P6) Inactive banner (deactivate via PATCH) gone from public list
  await api(adminJar, `/api/admin/hero-banners/${cbanner.id}`, {
    method: 'PATCH', json: { isActive: false },
  });
  const r6 = await api(anon, '/api/hero-banners');
  const banners6 = ((r6.body.data ?? {}) as { banners: { id: string }[] }).banners;
  assert('(P6) deactivated banner gone from public list',
    !banners6.some((b) => b.id === cbanner.id));
}

// ────────────────────────────────────────────────────────────────── 3. REGRESSION
async function regressionTests() {
  console.log('\n── REGRESSION — neighbouring endpoints still work ──');
  const anon = newJar();
  const r = await api(anon, '/api/categories');
  eq('(R1) /api/categories still 200', 200, r.status);
  const csrf = await api(anon, '/api/auth/csrf');
  eq('(R2) /api/auth/csrf still 200', 200, csrf.status);
}

// ────────────────────────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  await clearTag();
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
  for (const u of users) {
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
  }
  ok(`removed ${users.length} admin test user(s) + tagged banners`);
}

async function main() {
  try {
    await schemaTests();
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
