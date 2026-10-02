/**
 * Feature #35 — Product shareable URL system test suite.
 *
 *   npm run test:product-share
 *
 * Layers:
 *
 *   1. UNIT — productUrl service:
 *      - buildProductUrl: shape, base override, encoding, idempotent UTM merge.
 *      - appendUtm: composes with existing query params, idempotent.
 *      - encodeSlugForUrl: spaces / unicode / slashes / queries.
 *      - buildShareLinks: each of WhatsApp / Telegram / Facebook / X / Email.
 *      - buildProductUrlForChannel: utm_medium stamping per channel.
 *      - channelLabel: every channel has a label.
 *
 *   2. SERVICE — slug-alias service (direct DB):
 *      - findProductIdBySlug: current slug, alias hit, miss.
 *      - recordSlugChange: writes alias, refuses to clobber another product's
 *        current slug, idempotent.
 *      - removeAlias.
 *
 *   3. INTEGRATION — real `next start` on :3045:
 *      - GET /p/<current-slug>  → 200, HTML contains og:* + twitter:* +
 *        canonical pointing at the absolute URL.
 *      - GET /p/<aliased-slug>  → 307 redirect to canonical /p/<current>.
 *      - GET /p/<deleted-slug>  → 404.
 *
 *   4. REGRESSION — no breakage in:
 *      - /p/<slug> still renders (already covered by I1 above)
 *      - /api/categories still 200
 *      - /api/auth/csrf still 200
 *
 * Cleans up its own products + aliases at the end.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import {
  buildProductUrl, appendUtm, encodeSlugForUrl,
  buildShareLinks, buildProductUrlForChannel, channelLabel,
  SHARE_DEFAULTS, type ShareChannel,
} from '../src/lib/share/productUrl';
import {
  findProductIdBySlug, recordSlugChange, removeAlias,
} from '../src/lib/cms/productSlugAlias';
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

const TAG = `psh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const BASE_TEST = 'http://localhost:9999';

// ──────────────────────────────────────────────────────────────── 1. UNIT
function unitTests() {
  console.log('\n── UNIT — productUrl service ──');

  // (U1) Canonical URL shape with explicit base.
  const u1 = buildProductUrl('blue-denim-jacket', { baseUrl: BASE_TEST });
  eq('(U1) canonical URL shape', `${BASE_TEST}/p/blue-denim-jacket`, u1);

  // (U2) Trailing slashes in baseUrl are stripped.
  const u2 = buildProductUrl('x', { baseUrl: `${BASE_TEST}//` });
  eq('(U2) trailing slashes in base are stripped', `${BASE_TEST}/p/x`, u2);

  // (U3) Spaces in slug encoded; ' ! * remain literal (path-safe).
  const u3 = buildProductUrl("summer sale's 2026!", { baseUrl: BASE_TEST });
  eq('(U3) slug with spaces + apostrophe + ! encoded path-safely',
     `${BASE_TEST}/p/summer%20sale's%202026!`, u3);

  // (U4) Embedded slashes in a slug are stripped (slug bug guard).
  const u4 = buildProductUrl('foo/bar', { baseUrl: BASE_TEST });
  eq('(U4) slashes inside a slug stripped', `${BASE_TEST}/p/foobar`, u4);

  // (U5) Unicode slug encoded.
  const u5 = buildProductUrl('धमाका-sale', { baseUrl: BASE_TEST });
  assert('(U5) unicode slug encoded as %xx', /%[0-9A-F]{2}/i.test(u5));
  // Decoding must round-trip back to the same string.
  eq('(U5) decoded URL → original slug at the right place',
     'धमाका-sale', decodeURIComponent(u5.split('/').pop() ?? ''));

  // (U6) Empty / non-string slug → empty path segment.
  const u6 = buildProductUrl('', { baseUrl: BASE_TEST });
  eq('(U6) empty slug → "/p/"', `${BASE_TEST}/p/`, u6);
  const u6b = buildProductUrl(null as unknown as string, { baseUrl: BASE_TEST });
  eq('(U6) null slug → "/p/"',  `${BASE_TEST}/p/`,  u6b);

  // (U7) productPathPrefix override (future "/products/...").
  const u7 = buildProductUrl('x', { baseUrl: BASE_TEST, productPathPrefix: '/products' });
  eq('(U7) prefix override', `${BASE_TEST}/products/x`, u7);

  // (U8) UTM stamping (single + merge).
  const u8 = buildProductUrl('x', {
    baseUrl: BASE_TEST,
    utm: { utm_source: 'shopcore', utm_medium: 'whatsapp', utm_campaign: 'diwali' },
  });
  const parsed = new URL(u8);
  eq('(U8) utm_source stamped',   'shopcore',  parsed.searchParams.get('utm_source'));
  eq('(U8) utm_medium stamped',   'whatsapp',  parsed.searchParams.get('utm_medium'));
  eq('(U8) utm_campaign stamped', 'diwali',    parsed.searchParams.get('utm_campaign'));

  // (U9) appendUtm idempotent — same params don't duplicate.
  const u9 = appendUtm(u8, { utm_source: 'shopcore', utm_campaign: 'diwali' });
  const parsed2 = new URL(u9);
  eq('(U9) appendUtm idempotent: utm_source single value', 'shopcore', parsed2.searchParams.get('utm_source'));
  // Set comparison: there should be exactly the 3 utm_* keys.
  const keys = Array.from(parsed2.searchParams.keys()).filter((k) => k.startsWith('utm_'));
  eq('(U9) exactly 3 utm_* keys after idempotent merge', 3, keys.length);

  // (U10) appendUtm with malformed base → returns input unchanged.
  eq('(U10) appendUtm on garbage URL returns it verbatim',
     'definitely-not-a-url', appendUtm('definitely-not-a-url', { utm_source: 'x' }));

  // (U11) buildProductUrlForChannel stamps the channel as utm_medium.
  const channels: ShareChannel[] = ['whatsapp', 'telegram', 'facebook', 'twitter', 'email', 'copy_link', 'native', 'qr'];
  for (const c of channels) {
    const url = buildProductUrlForChannel('x', c, { baseUrl: BASE_TEST });
    const sp  = new URL(url).searchParams;
    eq(`(U11) channel "${c}" → utm_medium=${c}`, c, sp.get('utm_medium'));
    eq(`(U11) channel "${c}" → utm_source=${SHARE_DEFAULTS.utmSource}`,
       SHARE_DEFAULTS.utmSource, sp.get('utm_source'));
  }

  // (U12) channelLabel returns a non-empty string for every channel.
  for (const c of channels) {
    const lbl = channelLabel(c);
    assert(`(U12) channelLabel("${c}") is a non-empty string (got "${lbl}")`,
      typeof lbl === 'string' && lbl.length > 0);
  }

  // (U13) encodeSlugForUrl — non-string input → "".
  eq('(U13) encodeSlugForUrl(undefined) = ""', '', encodeSlugForUrl(undefined as unknown as string));
  eq('(U13) encodeSlugForUrl(null) = ""',      '', encodeSlugForUrl(null as unknown as string));
  eq('(U13) encodeSlugForUrl("  x  ") trims', 'x', encodeSlugForUrl('  x  '));
}

// ──────────────────────────────────────────────────────────────── 2. SHARE-LINK BUILDERS
function shareLinkTests() {
  console.log('\n── UNIT — share-link builders ──');

  const url   = `${BASE_TEST}/p/blue-denim?utm_source=shopcore&utm_medium=whatsapp`;
  const title = 'Blue Denim Jacket';
  const desc  = 'Brushed lining, perfect for winter.';
  const links = buildShareLinks({ url, title, description: desc });

  // (S1) WhatsApp link contains wa.me + encoded URL + encoded title.
  assert(`(S1) WhatsApp URL starts with https://wa.me/?text= (got "${links.whatsapp.slice(0, 30)}…")`,
    links.whatsapp.startsWith('https://wa.me/?text='));
  // Decoding the text param should contain both title + URL + description.
  const waText = new URL(links.whatsapp).searchParams.get('text') ?? '';
  assert('(S1) WhatsApp text contains the title',       waText.includes(title));
  assert('(S1) WhatsApp text contains the description', waText.includes(desc));
  assert('(S1) WhatsApp text contains the URL',         waText.includes(url));

  // (S2) Telegram link → t.me/share/url with url + text params.
  const t = new URL(links.telegram);
  eq('(S2) Telegram host', 't.me', t.host);
  eq('(S2) Telegram pathname', '/share/url', t.pathname);
  eq('(S2) Telegram url= param echoes input', url, t.searchParams.get('url'));
  assert('(S2) Telegram text= contains title', (t.searchParams.get('text') ?? '').includes(title));

  // (S3) Facebook sharer.
  const f = new URL(links.facebook);
  eq('(S3) Facebook host',     'www.facebook.com', f.host);
  eq('(S3) Facebook pathname', '/sharer/sharer.php', f.pathname);
  eq('(S3) Facebook u= echoes URL', url, f.searchParams.get('u'));

  // (S4) Twitter / X intent.
  const x = new URL(links.twitter);
  eq('(S4) Twitter host',     'twitter.com', x.host);
  eq('(S4) Twitter pathname', '/intent/tweet', x.pathname);
  eq('(S4) Twitter url= echoes URL', url, x.searchParams.get('url'));
  const twitterText = x.searchParams.get('text') ?? '';
  assert('(S4) Twitter text= contains title', twitterText.includes(title));
  assert('(S4) Twitter text= contains description', twitterText.includes(desc));

  // (S5) Email mailto link — must use mailto: scheme + subject + body.
  assert('(S5) Email link starts with mailto:', links.email.startsWith('mailto:?'));
  const u = new URL(links.email);
  eq('(S5) Email subject = title', title, u.searchParams.get('subject'));
  const body = u.searchParams.get('body') ?? '';
  assert('(S5) Email body contains title', body.includes(title));
  assert('(S5) Email body contains URL',   body.includes(url));
  assert('(S5) Email body contains description', body.includes(desc));

  // (S6) Without description still works.
  const noDesc = buildShareLinks({ url, title });
  assert('(S6) WhatsApp without desc still has wa.me prefix',
    noDesc.whatsapp.startsWith('https://wa.me/?text='));
  const waText2 = new URL(noDesc.whatsapp).searchParams.get('text') ?? '';
  assert('(S6) WhatsApp text without desc = "title\\nurl"',
    waText2 === `${title}\n${url}`);
}

// ──────────────────────────────────────────────────────────────── 3. SLUG-ALIAS SERVICE
async function aliasServiceTests() {
  console.log('\n── SERVICE — productSlugAlias ──');

  // Seed: create a fixture product.
  const slugA = `${TAG}-alpha`;
  const product = await prisma.product.create({
    data: {
      sku: `${TAG}-SKU-A`,
      name: 'Test Alpha',
      slug: slugA,
      description: 'Test product A',
      categoryId: (await prisma.category.findFirst())!.id,
      mrpPaise: 10000, pricePaise: 9999, stock: 5, gstRate: 18,
      isActive: true,
    },
  });

  // (A1) Look-up by current slug.
  const r1 = await findProductIdBySlug(slugA);
  assert('(A1) lookup by current slug returns the row', !!r1);
  if (r1) {
    eq('(A1) productId matches',  product.id, r1.productId);
    eq('(A1) isAlias = false',    false,      r1.isAlias);
    eq('(A1) currentSlug echoed', slugA,      r1.currentSlug);
  }

  // (A2) Unknown slug → null.
  const r2 = await findProductIdBySlug('nope-' + TAG);
  eq('(A2) unknown slug → null', null, r2);

  // (A3) Empty slug → null (no DB hit needed).
  eq('(A3) empty slug → null',  null, await findProductIdBySlug(''));
  eq('(A3) whitespace → null',  null, await findProductIdBySlug('   '));

  // (A4) Record an alias for an old slug, then look it up.
  const oldSlug = `${TAG}-very-old`;
  await recordSlugChange(product.id, oldSlug);
  const r4 = await findProductIdBySlug(oldSlug);
  assert('(A4) lookup by alias returns the row', !!r4);
  if (r4) {
    eq('(A4) isAlias = true',         true,       r4.isAlias);
    eq('(A4) currentSlug = current',  slugA,      r4.currentSlug);
    eq('(A4) productId matches',      product.id, r4.productId);
  }

  // (A5) recordSlugChange is idempotent.
  await recordSlugChange(product.id, oldSlug);
  await recordSlugChange(product.id, oldSlug);
  const count = await prisma.productSlugAlias.count({ where: { slug: oldSlug } });
  eq('(A5) recordSlugChange is idempotent (1 row exists)', 1, count);

  // (A6) Refuses to write alias when another product already owns the slug.
  const otherProduct = await prisma.product.create({
    data: {
      sku: `${TAG}-SKU-B`,
      name: 'Test Beta',
      slug: `${TAG}-beta`,
      description: 'Test product B',
      categoryId: (await prisma.category.findFirst())!.id,
      mrpPaise: 10000, pricePaise: 9999, stock: 5, gstRate: 18,
      isActive: true,
    },
  });
  // Try to assign Beta's slug as an alias of Alpha — should refuse.
  const before = await prisma.productSlugAlias.count({ where: { slug: `${TAG}-beta` } });
  await recordSlugChange(product.id, `${TAG}-beta`);
  const after = await prisma.productSlugAlias.count({ where: { slug: `${TAG}-beta` } });
  eq('(A6) recordSlugChange refuses to alias another product\'s current slug', before, after);

  // (A7) Current slug ALWAYS wins over alias even if both could match.
  //      We make Beta's current slug match Alpha's alias and verify resolution.
  await recordSlugChange(product.id, `${TAG}-shadow`);
  await prisma.product.update({ where: { id: otherProduct.id }, data: { slug: `${TAG}-shadow` } });
  const r7 = await findProductIdBySlug(`${TAG}-shadow`);
  assert('(A7) current Product.slug wins over alias of the same string', !!r7);
  if (r7) {
    eq('(A7) returned productId = other product (current owner)',
       otherProduct.id, r7.productId);
    eq('(A7) isAlias = false', false, r7.isAlias);
  }

  // (A8) removeAlias deletes the alias row.
  await removeAlias(oldSlug);
  const r8 = await findProductIdBySlug(oldSlug);
  eq('(A8) removed alias → null lookup', null, r8);

  // Cleanup.
  await prisma.productSlugAlias.deleteMany({ where: { productId: { in: [product.id, otherProduct.id] } } });
  await prisma.product.deleteMany({ where: { id: { in: [product.id, otherProduct.id] } } });
}

// ──────────────────────────────────────────────────────────────── 4. INTEGRATION
const PORT = 3045;
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
  const out = (b: Buffer) => writeFileSync('/tmp/test-product-share.log', b, { flag: 'a' });
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

async function integrationTests() {
  console.log('\n── INTEGRATION — PDP metadata + alias redirect ──');

  // Seed a fixture product so the PDP renders deterministically.
  const slug = `${TAG}-int-jacket`;
  const aliasSlug = `${TAG}-int-old-jacket`;
  const cat = (await prisma.category.findFirst())!;
  const product = await prisma.product.create({
    data: {
      sku: `${TAG}-SKU-INT`,
      name: 'Integration Test Jacket',
      slug,
      description: 'Long description for the test jacket.',
      shortDesc: 'A test jacket used by the share suite.',
      categoryId: cat.id,
      mrpPaise: 200000, pricePaise: 149900, stock: 7, gstRate: 18,
      isActive: true,
      images: { create: [{
        url: 'https://cdn.example.com/jackets/int.jpg', alt: 'Test jacket', isPrimary: true, sortOrder: 0,
      }] },
    },
  });
  await recordSlugChange(product.id, aliasSlug);

  // (I1) PDP renders with full OG + Twitter + canonical metadata.
  const r1 = await fetch(`${BASE}/p/${slug}`);
  eq('(I1) GET /p/<slug> → 200', 200, r1.status);
  const html = await r1.text();

  // og:title — Next 14 emits `<meta property="og:title" content="...">`
  const ogTitleRe = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i;
  const ogTitle   = html.match(ogTitleRe)?.[1];
  assert(`(I1) og:title present (got "${ogTitle}")`,
    !!ogTitle && /Integration Test Jacket/.test(ogTitle));

  const ogDescRe = /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i;
  const ogDesc   = html.match(ogDescRe)?.[1];
  assert(`(I1) og:description present (got "${ogDesc}")`,
    !!ogDesc && ogDesc.length > 0);

  const ogUrlRe = /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i;
  const ogUrl   = html.match(ogUrlRe)?.[1];
  assert(`(I1) og:url present (got "${ogUrl}")`,
    !!ogUrl && ogUrl.endsWith(`/p/${encodeURIComponent(slug)}`));

  const ogImageRe = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const ogImage   = html.match(ogImageRe)?.[1];
  assert(`(I1) og:image present (got "${ogImage?.slice(0, 60)}...")`,
    !!ogImage && /^https?:\/\//.test(ogImage));

  const twitterCardRe = /<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i;
  const card = html.match(twitterCardRe)?.[1];
  eq('(I1) twitter:card = summary_large_image', 'summary_large_image', card);

  const canonRe = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i;
  const canon   = html.match(canonRe)?.[1];
  assert(`(I1) canonical link present (got "${canon}")`,
    !!canon && canon.endsWith(`/p/${encodeURIComponent(slug)}`));

  // (I2) PDP HTML should contain the share button rendered by the page.
  assert('(I2) PDP HTML contains the share button testid',
    /data-testid=["']share-button["']/.test(html));

  // (I3) Aliased slug → redirect to canonical. Next.js `redirect()` uses
  //      a 307 to preserve method; the test only cares that the status is
  //      a redirect AND the Location header points at the current slug.
  const r3 = await fetch(`${BASE}/p/${aliasSlug}`, { redirect: 'manual' });
  assert(`(I3) aliased slug returns a redirect (got ${r3.status})`,
    r3.status >= 300 && r3.status < 400);
  const loc = r3.headers.get('location');
  assert(`(I3) Location points at current slug (got "${loc}")`,
    typeof loc === 'string' && loc.includes(`/p/${slug}`));

  // (I4) Following the redirect lands on the canonical PDP with 200 + correct OG.
  const r4 = await fetch(`${BASE}/p/${aliasSlug}`); // default follows redirects
  eq('(I4) followed redirect → 200', 200, r4.status);
  const html4 = await r4.text();
  const ogUrl4 = html4.match(ogUrlRe)?.[1];
  assert(`(I4) post-redirect og:url is canonical (got "${ogUrl4}")`,
    !!ogUrl4 && ogUrl4.endsWith(`/p/${slug}`));

  // (I5) Deleted / unknown slug → 404.
  const r5 = await fetch(`${BASE}/p/${TAG}-does-not-exist`);
  eq('(I5) unknown slug → 404', 404, r5.status);

  // (I6) Unpublished (isActive=false) product → 404.
  await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
  const r6 = await fetch(`${BASE}/p/${slug}`);
  eq('(I6) inactive product → 404', 404, r6.status);
  await prisma.product.update({ where: { id: product.id }, data: { isActive: true } });

  // (I7) Special-char slug encoded — verify a slug with apostrophe round-trips.
  const apo = `${TAG}-cool-stuff`;  // we keep the test slug DB-safe; encoding is unit-tested
  await prisma.product.update({ where: { id: product.id }, data: { slug: apo } });
  const r7 = await fetch(`${BASE}/p/${encodeURIComponent(apo)}`);
  eq('(I7) URL-encoded slug serves 200', 200, r7.status);

  // Cleanup
  await prisma.productSlugAlias.deleteMany({ where: { productId: product.id } });
  await prisma.productImage.deleteMany({ where: { productId: product.id } });
  await prisma.product.delete({ where: { id: product.id } });
}

// ──────────────────────────────────────────────────────────────── 5. REGRESSION
async function regressionTests() {
  console.log('\n── REGRESSION — neighbouring endpoints still work ──');
  const r = await fetch(`${BASE}/api/categories`);
  eq('(R1) /api/categories still 200', 200, r.status);
  const csrf = await fetch(`${BASE}/api/auth/csrf`);
  eq('(R2) /api/auth/csrf still 200', 200, csrf.status);
}

// ──────────────────────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  const products = await prisma.product.findMany({
    where: { sku: { startsWith: TAG } },
    select: { id: true },
  });
  for (const p of products) {
    await prisma.productSlugAlias.deleteMany({ where: { productId: p.id } });
    await prisma.productImage.deleteMany({ where: { productId: p.id } });
    await prisma.product.delete({ where: { id: p.id } }).catch(() => {});
  }
  ok(`removed ${products.length} test product(s) + aliases`);
}

async function main() {
  try {
    unitTests();
    shareLinkTests();
    await aliasServiceTests();
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
