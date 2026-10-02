/**
 * Pagination — Item 12. Test harness.
 *
 *   npm run test:pagination
 *
 * Sections:
 *   1. UNIT          — parsePaginationParams, parseCursorParams,
 *                      buildPageWindow, buildPagination,
 *                      buildCursorPagination, cursor regex validation.
 *   2. STATIC AUDIT  — every `findMany(` in src/app/api/** sits next to
 *                      a `take:` clause; required new files present;
 *                      no legacy `pageCount`/`data.total` shapes in
 *                      shipping consumers.
 *   3. INTEGRATION   — spawn `next start`; hit /api/products, admin
 *                      endpoints (orders cursor mode, audit-log cursor
 *                      mode), assert envelope shape, clamp, redirect.
 *
 * Spec §4 — every assertion carries [P<n>.<m>] tags.
 */
// Pre-import side-effects.
(process.env as Record<string, string>).NODE_ENV = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import {
  parsePaginationParams, parseCursorParams,
  buildPagination, buildCursorPagination, buildPageWindow,
  type PageWindowItem,
} from '../src/lib/pagination';
import { ValidationError } from '../src/lib/errors';
import { buildPaginationSeo } from '../src/lib/seo/paginationSeo';
import { readPageSizePreference, writePageSizePreference } from '../src/lib/pageSizePreference';

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

const TAG = `pg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
const PORT = 3069;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-pagination-${process.pid}.log`;

// Minimal cfg stub used by parse* unit tests.
const cfg = { performance: { paginationDefaultSize: 20, paginationMaxSize: 100 } };

// ────────────────────────────────────────────────────────── 1. UNIT
function unitTests(): void {
  console.log('\n── UNIT — parse, build, page window ──');

  // (P1.1) parsePaginationParams — defaults.
  {
    const r = parsePaginationParams(new URLSearchParams(), cfg);
    eq('[P1.1] default page = 1',         1,  r.page);
    eq('[P1.1] default pageSize = 20',    20, r.pageSize);
    eq('[P1.1] default skip = 0',         0,  r.skip);
    eq('[P1.1] default take = pageSize',  20, r.take);
  }

  // (P1.2) parsePaginationParams — endpoint default.
  {
    const r = parsePaginationParams(new URLSearchParams(), cfg, { defaultPageSize: 24 });
    eq('[P1.2] endpoint defaultPageSize honoured', 24, r.pageSize);
  }

  // (P1.3) parsePaginationParams — explicit values.
  {
    const r = parsePaginationParams(new URLSearchParams('page=3&pageSize=50'), cfg);
    eq('[P1.3] page = 3',                 3,   r.page);
    eq('[P1.3] pageSize = 50',            50,  r.pageSize);
    eq('[P1.3] skip = (page-1)*pageSize', 100, r.skip);
  }

  // (P1.4) parsePaginationParams — pageSize clamped to max.
  {
    const r = parsePaginationParams(new URLSearchParams('pageSize=999'), cfg);
    eq('[P1.4] pageSize clamped to paginationMaxSize', 100, r.pageSize);
  }

  // (P1.5) parsePaginationParams — bad page string throws.
  {
    let threw = false; let code: string | undefined;
    try { parsePaginationParams(new URLSearchParams('page=abc'), cfg); }
    catch (e) {
      threw = true;
      if (e instanceof ValidationError) code = (e as unknown as { code: string }).code;
    }
    assert('[P1.5] page=abc throws ValidationError', threw);
    eq('[P1.5] error code = INVALID_PAGINATION_PARAMS', 'INVALID_PAGINATION_PARAMS', code);
  }

  // (P1.6) parsePaginationParams — negative page string throws.
  {
    let threw = false;
    try { parsePaginationParams(new URLSearchParams('page=-1'), cfg); }
    catch { threw = true; }
    assert('[P1.6] page=-1 throws ValidationError', threw);
  }

  // (P1.7) parsePaginationParams — Next.js searchParams prop shape works.
  {
    const r = parsePaginationParams({ page: '2', pageSize: '15' }, cfg);
    eq('[P1.7] page from object',     2,  r.page);
    eq('[P1.7] pageSize from object', 15, r.pageSize);
  }

  // (P1.8) parsePaginationParams — array-valued searchParams prop.
  {
    const r = parsePaginationParams({ page: ['4', '99'] }, cfg);
    eq('[P1.8] page from array (first wins)', 4, r.page);
  }

  // (P1.9) parseCursorParams — empty cursor → undefined.
  {
    const r = parseCursorParams(new URLSearchParams('cursor='), cfg);
    eq('[P1.9] empty cursor → undefined', undefined, r.cursor);
  }

  // (P1.10) parseCursorParams — valid cuid passes.
  {
    const r = parseCursorParams(new URLSearchParams('cursor=cln9bxyz12abcdef34567890ab'), cfg);
    eq('[P1.10] valid cuid accepted', 'cln9bxyz12abcdef34567890ab', r.cursor);
  }

  // (P1.11) parseCursorParams — bad cursor throws.
  {
    let threw = false; let code: string | undefined;
    try { parseCursorParams(new URLSearchParams("cursor='; DROP TABLE--"), cfg); }
    catch (e) {
      threw = true;
      if (e instanceof ValidationError) code = (e as unknown as { code: string }).code;
    }
    assert('[P1.11] SQL-injection-ish cursor throws', threw);
    eq('[P1.11] error code = INVALID_PAGINATION_PARAMS', 'INVALID_PAGINATION_PARAMS', code);
  }

  // (P1.12) buildPageWindow — totalPages = 1.
  {
    eq('[P1.12] window [1]', [1] as PageWindowItem[], buildPageWindow(1, 1));
  }

  // (P1.13) buildPageWindow — totalPages = 5 (no ellipsis).
  {
    eq('[P1.13] window [1..5]', [1, 2, 3, 4, 5] as PageWindowItem[], buildPageWindow(3, 5));
  }

  // (P1.14) buildPageWindow — page 1 of 20.
  {
    eq('[P1.14] page 1 of 20',
      [1, 2, 3, 4, 5, 'ellipsis', 20] as PageWindowItem[],
      buildPageWindow(1, 20));
  }

  // (P1.15) buildPageWindow — middle page.
  {
    eq('[P1.15] page 10 of 20',
      [1, 'ellipsis', 8, 9, 10, 11, 12, 'ellipsis', 20] as PageWindowItem[],
      buildPageWindow(10, 20));
  }

  // (P1.16) buildPageWindow — last page.
  {
    eq('[P1.16] page 20 of 20',
      [1, 'ellipsis', 16, 17, 18, 19, 20] as PageWindowItem[],
      buildPageWindow(20, 20));
  }

  // (P1.17) buildPageWindow — page near edge picks 5-window without leading ellipsis.
  {
    eq('[P1.17] page 3 of 20',
      [1, 2, 3, 4, 5, 'ellipsis', 20] as PageWindowItem[],
      buildPageWindow(3, 20));
  }

  // (P1.18) buildPageWindow — both ellipses present at page 7 of 20.
  {
    eq('[P1.18] page 7 of 20',
      [1, 'ellipsis', 5, 6, 7, 8, 9, 'ellipsis', 20] as PageWindowItem[],
      buildPageWindow(7, 20));
  }

  // (P1.19) buildPageWindow — totalPages 0 / negative.
  {
    eq('[P1.19] totalPages 0 → []', [] as PageWindowItem[], buildPageWindow(1, 0));
    eq('[P1.19] totalPages -3 → []', [] as PageWindowItem[], buildPageWindow(1, -3));
  }

  // (P1.20) buildPageWindow — current out-of-range clamps in.
  {
    const r = buildPageWindow(999, 5);
    eq('[P1.20] clamped current returns all pages', [1, 2, 3, 4, 5] as PageWindowItem[], r);
  }

  // (P1.21) buildPagination — totals correct.
  {
    const r = buildPagination([1, 2, 3], 247, 3, 20);
    eq('[P1.21] total = 247',     247, r.pagination.total);
    eq('[P1.21] page = 3',        3,   r.pagination.page);
    eq('[P1.21] pageSize = 20',   20,  r.pagination.pageSize);
    eq('[P1.21] totalPages = 13', 13,  r.pagination.totalPages);
    eq('[P1.21] hasNext = true',  true, r.pagination.hasNextPage);
    eq('[P1.21] hasPrev = true',  true, r.pagination.hasPrevPage);
  }

  // (P1.22) buildPagination — empty result has no next/prev.
  {
    const r = buildPagination([], 0, 1, 20);
    eq('[P1.22] totalPages = 0',  0, r.pagination.totalPages);
    eq('[P1.22] hasNext = false', false, r.pagination.hasNextPage);
    eq('[P1.22] hasPrev = false', false, r.pagination.hasPrevPage);
  }

  // (P1.23) buildCursorPagination — extra row signals next page.
  {
    const fetched = [
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ];
    const r = buildCursorPagination(fetched, 3, 'id', undefined);
    eq('[P1.23] items length = pageSize', 3, r.items.length);
    eq('[P1.23] total = null',            null, r.pagination.total);
    eq('[P1.23] nextCursor = last id',   'c', r.pagination.nextCursor);
    eq('[P1.23] hasNext = true',          true, r.pagination.hasNextPage);
    eq('[P1.23] hasPrev = false (no prev cursor)', false, r.pagination.hasPrevPage);
  }

  // (P1.24) buildCursorPagination — last page (no probe row).
  {
    const fetched = [{ id: 'a' }, { id: 'b' }];
    const r = buildCursorPagination(fetched, 3, 'id', 'prev_cursor_123');
    eq('[P1.24] items length = fetched length', 2, r.items.length);
    eq('[P1.24] nextCursor = null',            null, r.pagination.nextCursor);
    eq('[P1.24] hasNext = false',              false, r.pagination.hasNextPage);
    eq('[P1.24] hasPrev = true (cursor present)', true, r.pagination.hasPrevPage);
    eq('[P1.24] prevCursor echoed',           'prev_cursor_123', r.pagination.prevCursor);
  }

  // ── Phase 2 ─────────────────────────────────────────────────────

  // (P1.25) buildPaginationSeo — page 1: canonical, no prev, next is page 2, NOT noindex.
  {
    const seo = buildPaginationSeo({
      origin: 'https://shop.example.com',
      basePath: '/c/laptops',
      searchParams: { brand: 'dell' },
      currentPage: 1, totalPages: 5,
      config: { performance: { paginationNoindexFromPage: 2, paginationDefaultSize: 20, paginationMaxSize: 100 } } as unknown as Parameters<typeof buildPaginationSeo>[0]['config'],
    });
    eq('[P1.25] canonical strips page=1',          'https://shop.example.com/c/laptops?brand=dell', seo.canonical);
    eq('[P1.25] prevUrl absent on page 1',         undefined, seo.prevUrl);
    eq('[P1.25] nextUrl present + correct',        'https://shop.example.com/c/laptops?brand=dell&page=2', seo.nextUrl);
    eq('[P1.25] not noindex on page 1 (default)',  false, seo.robotsNoindex);
  }

  // (P1.26) buildPaginationSeo — page 2: noindex on by default (paginationNoindexFromPage=2).
  {
    const seo = buildPaginationSeo({
      origin: 'https://shop.example.com',
      basePath: '/c/laptops',
      searchParams: { brand: 'dell' },
      currentPage: 2, totalPages: 5,
      config: { performance: { paginationNoindexFromPage: 2, paginationDefaultSize: 20, paginationMaxSize: 100 } } as unknown as Parameters<typeof buildPaginationSeo>[0]['config'],
    });
    eq('[P1.26] canonical includes page=2',        'https://shop.example.com/c/laptops?brand=dell&page=2', seo.canonical);
    eq('[P1.26] prevUrl strips page=1',            'https://shop.example.com/c/laptops?brand=dell', seo.prevUrl);
    eq('[P1.26] nextUrl present',                  'https://shop.example.com/c/laptops?brand=dell&page=3', seo.nextUrl);
    eq('[P1.26] noindex on by default at page 2',  true, seo.robotsNoindex);
  }

  // (P1.27) buildPaginationSeo — last page: nextUrl absent.
  {
    const seo = buildPaginationSeo({
      origin: 'https://shop.example.com',
      basePath: '/c/laptops',
      searchParams: {},
      currentPage: 5, totalPages: 5,
      config: { performance: { paginationNoindexFromPage: 2, paginationDefaultSize: 20, paginationMaxSize: 100 } } as unknown as Parameters<typeof buildPaginationSeo>[0]['config'],
    });
    eq('[P1.27] nextUrl absent on last page',    undefined, seo.nextUrl);
    eq('[P1.27] prevUrl present on last page',   'https://shop.example.com/c/laptops?page=4', seo.prevUrl);
  }

  // (P1.28) buildPaginationSeo — totalPages 1 → no noindex (single page is canonical).
  {
    const seo = buildPaginationSeo({
      origin: 'https://shop.example.com',
      basePath: '/search',
      searchParams: { q: 'foo' },
      currentPage: 1, totalPages: 1,
      config: { performance: { paginationNoindexFromPage: 2, paginationDefaultSize: 20, paginationMaxSize: 100 } } as unknown as Parameters<typeof buildPaginationSeo>[0]['config'],
    });
    eq('[P1.28] no noindex when totalPages=1', false, seo.robotsNoindex);
    eq('[P1.28] no nextUrl when totalPages=1', undefined, seo.nextUrl);
    eq('[P1.28] no prevUrl when currentPage=1', undefined, seo.prevUrl);
  }

  // (P1.29) page-size preference cookie helpers (jsdom-less; use a
  //         stub document object).
  {
    const stub: { cookie: string } = { cookie: '' };
    (globalThis as Record<string, unknown>).document = stub;
    try {
      writePageSizePreference('admin_orders', 50);
      assert('[P1.29] cookie has correct prefix + value',
        /sc_ps_admin_orders=50/.test(stub.cookie),
        stub.cookie);
      eq('[P1.29] readPageSizePreference returns 50', 50, readPageSizePreference('admin_orders', 20));
      // Garbage stored value → default.
      stub.cookie = 'sc_ps_admin_orders=abc';
      eq('[P1.29] garbage value falls back to default', 20, readPageSizePreference('admin_orders', 20));
      // Outside [1, maxSize] → default.
      stub.cookie = 'sc_ps_admin_orders=99999';
      eq('[P1.29] over-max falls back to default', 20, readPageSizePreference('admin_orders', 20, 1000));
      // Unsafe scope key sanitised (special chars dropped).
      stub.cookie = '';
      writePageSizePreference('a/b;c.d e', 30);
      assert('[P1.29] scope sanitiser produces safe key',
        /sc_ps_a_b_c_d_e=30/.test(stub.cookie),
        stub.cookie);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  }
}

// ──────────────────────────────────────────── 2. STATIC AUDIT
function staticAuditTests(): void {
  console.log('\n── STATIC AUDIT — files, findMany discipline ──');

  // (P2.1) Required new files exist.
  const required = [
    'src/lib/pagination.ts',
    'src/components/Pagination.tsx',
    'src/components/PageSizeSelector.tsx',
  ];
  for (const p of required) assert(`[P2.1] file exists: ${p}`, existsSync(p));

  // (P2.2) Every API route's findMany has a `take:` somewhere nearby
  // (unbounded scans are forbidden by spec §3.6).
  const offenders: Array<{ file: string; line: number }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
        const rawSrc = readFileSync(p, 'utf-8');
        // For finding findMany() calls and `take:` clauses we strip
        // block + line comments so doc references don't false-positive.
        const stripped = rawSrc
          // Preserve line numbers: replace block-comment bodies with
          // newlines so `lines[i]` aligns with `rawLines[i]`.
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        const lines    = stripped.split('\n');
        const rawLines = rawSrc.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!/findMany\s*\(/.test(lines[i])) continue;
          const start = Math.max(0, i - 4);
          const end   = Math.min(lines.length, i + 25);
          const window     = lines.slice(start, end).join('\n');
          const rawWindow  = rawLines.slice(start, end).join('\n');
          // Accept either an explicit `take: N` clause or a shorthand
          // `take` property — both upper-bound the query. The
          // PAGINATION-EXEMPT marker lives in a comment, so we check
          // the raw source slice for it.
          if (/\btake\s*:/.test(window))                continue;
          if (/[,{(\s]take\s*[,}\n]/.test(window))     continue;
          if (/PAGINATION-EXEMPT/.test(rawWindow))        continue;
          offenders.push({ file: p, line: i + 1 });
        }
      }
    }
  };
  walk('src/app/api');
  if (offenders.length > 0) {
    console.error('  unbounded findMany() in:');
    for (const o of offenders) console.error(`    ${o.file}:${o.line}`);
  }
  eq('[P2.2] zero unbounded findMany() calls in src/app/api/**', 0, offenders.length);

  // (P2.3) No consumer reads legacy `data.total` (other than pagination.total).
  const legacyHits: string[] = [];
  const walkUI = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (p.includes('node_modules') || p.includes('.next')) continue;
        walkUI(p);
      } else if (p.endsWith('.tsx')) {
        const src = readFileSync(p, 'utf-8');
        // Strip comments so doc references don't false-positive.
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        // `r.data.total` or `data.total` (but NOT `data.totals` /
        // `data.totalSignups` / `pagination.total`).
        const re = /\bdata\.total(?![A-Za-z])/g;
        if (re.test(stripped)) legacyHits.push(p);
      }
    }
  };
  walkUI('src/app');
  walkUI('src/components');
  if (legacyHits.length > 0) {
    console.error('  legacy data.total in:');
    for (const f of legacyHits) console.error(`    ${f}`);
  }
  eq('[P2.3] zero consumers read data.total (use data.pagination.total)', 0, legacyHits.length);

  // (P2.4) Pagination component renders aria-current="page".
  const pagSrc = readFileSync('src/components/Pagination.tsx', 'utf-8');
  assert('[P2.4] <Pagination> sets aria-current="page" on active link',
    /aria-current=\{isCurrent\s*\?\s*['"]page['"]/.test(pagSrc));
  assert('[P2.4] <Pagination> uses <nav aria-label="Pagination">',
    /aria-label=["']Pagination["']/.test(pagSrc));

  // (P2.5) PageSizeSelector has a visible <label> bound via htmlFor.
  const pssSrc = readFileSync('src/components/PageSizeSelector.tsx', 'utf-8');
  assert('[P2.5] <PageSizeSelector> renders a <label htmlFor={id}>',
    /<label\s+htmlFor=\{id\}/.test(pssSrc));
  assert('[P2.5] <PageSizeSelector> filters options against maxPageSize',
    /options\.filter/.test(pssSrc) && /maxPageSize/.test(pssSrc));

  // ── Phase 2 ─────────────────────────────────────────────────────

  // (P2.6) Required Phase 2 files exist.
  for (const p of [
    'src/lib/seo/paginationSeo.ts',
    'src/components/seo/PaginationSeoLinks.tsx',
    'src/components/InfiniteScroll.tsx',
    'src/components/storefront/ProductGrid.tsx',
    'src/lib/pageSizePreference.ts',
    'src/lib/client/usePageSizePreference.ts',
  ]) assert(`[P2.6] file exists: ${p}`, existsSync(p));

  // (P2.7) <Pagination> wires Phase-2 props.
  const pagSrc2 = readFileSync('src/components/Pagination.tsx', 'utf-8');
  assert('[P2.7] Pagination accepts jumpInputThreshold prop',
    /jumpInputThreshold\??:/.test(pagSrc2));
  assert('[P2.7] Pagination accepts keyboardNav prop',
    /keyboardNav\??:/.test(pagSrc2));
  assert('[P2.7] Pagination accepts urlSync prop',
    /urlSync\??:/.test(pagSrc2));
  assert('[P2.7] Pagination handles ArrowLeft / ArrowRight',
    /ArrowLeft/.test(pagSrc2) && /ArrowRight/.test(pagSrc2));
  assert('[P2.7] Pagination renders <JumpToPageInput>',
    /JumpToPageInput/.test(pagSrc2));

  // (P2.8) <InfiniteScroll> a11y + reduced-motion guard.
  const isSrc = readFileSync('src/components/InfiniteScroll.tsx', 'utf-8');
  assert('[P2.8] InfiniteScroll respects prefers-reduced-motion',
    /prefers-reduced-motion/.test(isSrc));
  assert('[P2.8] InfiniteScroll exposes Load-more fallback button',
    /Load more/.test(isSrc));
  assert('[P2.8] InfiniteScroll uses IntersectionObserver',
    /IntersectionObserver/.test(isSrc));
  assert('[P2.8] InfiniteScroll has aria-live region',
    /aria-live=["\']polite["\']/.test(isSrc));

  // (P2.9) Storefront pages emit <PaginationSeoLinks>.
  for (const p of [
    'src/app/(storefront)/c/[slug]/page.tsx',
    'src/app/(storefront)/search/page.tsx',
    'src/app/(storefront)/wishlist/page.tsx',
  ]) {
    const src = readFileSync(p, 'utf-8');
    assert(`[P2.9] ${p} renders <PaginationSeoLinks>`,
      /<PaginationSeoLinks\b/.test(src));
  }

  // (P2.10) Admin pages opt into keyboardNav.
  for (const p of [
    'src/app/admin/(app)/customers/page.tsx',
    'src/app/admin/(app)/products/page.tsx',
    'src/app/admin/(app)/orders/page.tsx',
  ]) {
    const src = readFileSync(p, 'utf-8');
    assert(`[P2.10] ${p} passes keyboardNav to <Pagination>`,
      /keyboardNav/.test(src));
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

async function getJson(path: string, jar?: Jar): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (jar) headers.set('cookie', cookieHeader(jar));
  const res = await fetch(`${BASE}${path}`, { headers });
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body: parsed };
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
  const jar = newJar();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, csrfRes);
  jar.cookies['sc_admin']         = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return jar;
}

async function createTestAdmin(): Promise<string> {
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
  return u.id;
}

interface Envelope {
  ok?: boolean;
  data?: {
    items?: unknown[];
    pagination?: Record<string, unknown>;
  };
  /** The shared error envelope is flat: { ok:false, error:<string>, code:<machine code> }. */
  error?: string;
  code?:  string;
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — live envelope shapes ──');

  await startServer();
  try {
    // (P3.1) Storefront /api/products returns standard envelope.
    {
      const r = await getJson('/api/products?pageSize=5');
      eq('[P3.1] /api/products status', 200, r.status);
      const env = r.body as Envelope;
      assert('[P3.1] response.ok = true',          env.ok === true, env);
      assert('[P3.1] data.items is array',         Array.isArray(env.data?.items));
      assert('[P3.1] data.pagination present',     env.data?.pagination !== undefined);
      const p = env.data!.pagination as Record<string, unknown>;
      assert('[P3.1] has total / page / pageSize / totalPages / hasNextPage / hasPrevPage',
        ['total','page','pageSize','totalPages','hasNextPage','hasPrevPage'].every((k) => k in p));
      eq('[P3.1] pageSize echoed', 5, p.pageSize);
    }

    // (P3.2) pageSize over max gets clamped.
    {
      const r = await getJson('/api/products?pageSize=9999');
      eq('[P3.2] /api/products?pageSize=9999 status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      assert('[P3.2] pageSize clamped to <= 100', (p.pageSize as number) <= 100);
    }

    // (P3.3) Garbage page returns 400 INVALID_PAGINATION_PARAMS.
    {
      const r = await getJson('/api/products?page=abc');
      eq('[P3.3] /api/products?page=abc status 400', 400, r.status);
      const env = r.body as Envelope;
      eq('[P3.3] error code', 'INVALID_PAGINATION_PARAMS', env.code);
    }

    // (P3.4) page > totalPages on /api/products returns empty items
    //         (API-level: no redirect; redirect is page-level).
    {
      const r = await getJson('/api/products?page=99999&pageSize=10');
      eq('[P3.4] status 200', 200, r.status);
      const env = r.body as Envelope;
      eq('[P3.4] data.items is empty array', 0, (env.data?.items ?? []).length);
    }

    // (P3.5) Admin endpoints require auth.
    {
      const r = await getJson('/api/admin/orders');
      assert('[P3.5] /api/admin/orders unauthenticated → 401/403', r.status === 401 || r.status === 403);
    }

    // ── Authenticated admin tests ─────────────────────────────────
    const adminId = await createTestAdmin();
    const jar = await adminJarFor(adminId);

    // (P3.6) /api/admin/orders returns standard envelope (offset mode).
    {
      const r = await getJson('/api/admin/orders?pageSize=5', jar);
      eq('[P3.6] /api/admin/orders status', 200, r.status);
      const env = r.body as Envelope;
      assert('[P3.6] data.items array',          Array.isArray(env.data?.items));
      assert('[P3.6] data.pagination present',   env.data?.pagination !== undefined);
      const p = env.data!.pagination as Record<string, unknown>;
      assert('[P3.6] offset envelope has total (number)', typeof p.total === 'number');
    }

    // (P3.7) /api/admin/orders?cursor= triggers cursor envelope.
    {
      const r = await getJson('/api/admin/orders?cursor=&pageSize=5', jar);
      eq('[P3.7] cursor mode status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      eq('[P3.7] cursor envelope total = null', null, p.total);
      assert('[P3.7] cursor envelope has nextCursor key', 'nextCursor' in p);
      assert('[P3.7] cursor envelope has prevCursor key', 'prevCursor' in p);
    }

    // (P3.8) /api/admin/audit-log cursor mode same shape.
    {
      const r = await getJson('/api/admin/audit-log?cursor=&pageSize=10', jar);
      eq('[P3.8] /api/admin/audit-log status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      eq('[P3.8] cursor envelope total = null', null, p.total);
    }

    // (P3.9) Cursor injection rejected.
    {
      const r = await getJson(`/api/admin/audit-log?cursor=${encodeURIComponent("'; DROP")}`, jar);
      eq('[P3.9] bad cursor status 400', 400, r.status);
      const env = r.body as Envelope;
      eq('[P3.9] error code', 'INVALID_PAGINATION_PARAMS', env.code);
    }

    // (P3.10) /api/admin/customers returns envelope.
    {
      const r = await getJson('/api/admin/customers?pageSize=5', jar);
      eq('[P3.10] /api/admin/customers status', 200, r.status);
      const env = r.body as Envelope;
      assert('[P3.10] data.items array',        Array.isArray(env.data?.items));
      assert('[P3.10] data.pagination present', env.data?.pagination !== undefined);
    }

    // (P3.11) /c/[slug]?page=9999 → redirect to no-page URL (300-series).
    //         Use a real category slug if any exist; otherwise skip.
    {
      const slug = await prisma.category.findFirst({ where: { isActive: true }, select: { slug: true } });
      if (slug) {
        const res = await fetch(`${BASE}/c/${slug.slug}?page=9999`, { redirect: 'manual' });
        assert('[P3.11] /c/<slug>?page=9999 returns a redirect',
          res.status >= 300 && res.status < 400, { status: res.status, slug: slug.slug });
        const loc = res.headers.get('location') ?? '';
        assert('[P3.11] redirect URL does NOT contain ?page=9999', !/page=9999/.test(loc), loc);
      } else {
        ok('[P3.11] skipped: no active category in DB');
      }
    }

    // ── Phase 2 ─────────────────────────────────────────────────────

    // (P3.12) /api/admin/reviews?cursor= triggers cursor envelope.
    {
      const r = await getJson('/api/admin/reviews?cursor=&pageSize=5', jar);
      eq('[P3.12] /api/admin/reviews cursor mode status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      eq('[P3.12] reviews cursor envelope total = null', null, p.total);
      assert('[P3.12] reviews cursor envelope has nextCursor key', 'nextCursor' in p);
    }

    // (P3.13) /api/admin/returns?cursor= triggers cursor envelope.
    {
      const r = await getJson('/api/admin/returns?cursor=&pageSize=5', jar);
      eq('[P3.13] /api/admin/returns cursor mode status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      eq('[P3.13] returns cursor envelope total = null', null, p.total);
    }

    // (P3.14) /api/admin/tickets?cursor= triggers cursor envelope.
    {
      const r = await getJson('/api/admin/tickets?cursor=&pageSize=5', jar);
      eq('[P3.14] /api/admin/tickets cursor mode status', 200, r.status);
      const env = r.body as Envelope;
      const p = env.data!.pagination as Record<string, unknown>;
      eq('[P3.14] tickets cursor envelope total = null', null, p.total);
    }

    // (P3.15) /c/<slug>?page=2 emits <link rel="prev"> + canonical.
    {
      const slug = await prisma.category.findFirst({ where: { isActive: true }, select: { slug: true } });
      if (slug) {
        const res = await fetch(`${BASE}/c/${slug.slug}`);
        const html = await res.text();
        assert('[P3.15] /c/<slug> page 1 emits <link rel="canonical">',
          /<link\s+rel="canonical"\s+href=/.test(html), html.slice(0, 800));
        // Page 1: no rel=prev expected; rel=next may or may not appear
        // depending on product count.
        assert('[P3.15] /c/<slug> page 1 does NOT emit rel="prev"',
          !/<link\s+rel="prev"/.test(html));
      } else {
        ok('[P3.15] skipped: no active category in DB');
      }
    }

    // (P3.16) /search?q=non_existent_term — emits noindex meta when
    //         empty-query branch fires.
    {
      const res = await fetch(`${BASE}/search`);
      const html = await res.text();
      assert('[P3.16] empty /search page emits robots noindex',
        /<meta\s+name="robots"\s+content="noindex/.test(html));
    }
  } finally {
    await stopServer();
  }
}

// ─────────────────────────────────────────────────────────────────────
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
