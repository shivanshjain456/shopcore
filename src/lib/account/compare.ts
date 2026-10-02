/**
 * Compare service — Item 14.
 *
 * Single source of truth for the compare list. Two backends:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Anonymous (no session)                                         │
 *   │   Backed by the `sc_compare_v1` cookie (JSON-encoded string[]).│
 *   │   Cookie is `httpOnly: false` so the client `CompareProvider`  │
 *   │   can also read it for first-paint hydration.                  │
 *   └────────────────────────────────────────────────────────────────┘
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Authenticated                                                  │
 *   │   Backed by the `CompareItem` table (added by migration        │
 *   │   20260606120000_compare_feature). The (userId, productId)     │
 *   │   unique index makes idempotent concurrent inserts safe.       │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * On login, the cookie list is merged into the DB via
 * `POST /api/compare/sync` (caller passes the local productIds and we
 * de-duplicate + clip to maxItems). The cookie is then cleared by the
 * route handler.
 *
 * All write paths enforce `maxItems` (config-driven, hard ceiling 4).
 * Adding a 5th product throws `CompareListFullError` (code
 * `COMPARE_FULL`, mapped to HTTP 409 by the API layer).
 */
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/storeConfig';
import { ShopCoreError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';

// ── Constants ────────────────────────────────────────────────────────────

/** Cookie name — unchanged from the previous implementation, so a logged-out
 *  user with an old cookie continues to see their compare list. */
export const COMPARE_COOKIE = 'sc_compare_v1';

/** Hard ceiling regardless of the admin-set value. See storeConfig
 *  `compare.maxItems`. The 4-column layout breaks beyond 4 on most
 *  viewports. */
export const COMPARE_HARD_CAP = 4;

// ── Errors ───────────────────────────────────────────────────────────────

export class CompareListFullError extends ShopCoreError {
  public readonly statusCode = 409;
  constructor(maxItems: number) {
    super(`Compare list is full (max ${maxItems} products).`, {
      clientMessage: `You can compare up to ${maxItems} products at a time. Remove one to add another.`,
      code:          'COMPARE_FULL',
      context:       { maxItems },
    });
  }
}

// ── Cookie helpers (anonymous path) ──────────────────────────────────────

/** Read the raw productId array from the cookie. Defensive against
 *  any malformed JSON, non-string elements, and over-long arrays.
 *  Truncates silently to `COMPARE_HARD_CAP`. */
export function readCompareCookie(): string[] {
  const raw = cookies().get(COMPARE_COOKIE)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === 'string').slice(0, COMPARE_HARD_CAP);
  } catch {
    return [];
  }
}

/** Persist the productId array back to the cookie. */
export function writeCompareCookie(ids: string[]): void {
  cookies().set(COMPARE_COOKIE, JSON.stringify(ids.slice(0, COMPARE_HARD_CAP)), {
    httpOnly: false,     // client tray reads this for first-paint
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 30,
  });
}

/** Clear the cookie. Use on logout-merge so the local list doesn't
 *  out-of-sync with the server list across sessions. */
export function clearCompareCookie(): void {
  cookies().set(COMPARE_COOKIE, '', { path: '/', maxAge: 0 });
}

// ── Service surface ──────────────────────────────────────────────────────

/** Effective maximum — config value clamped against `COMPARE_HARD_CAP`. */
export async function getMaxItems(): Promise<number> {
  const cfg = await getStoreConfig();
  const raw = (cfg as { compare?: { maxItems?: number } }).compare?.maxItems;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : COMPARE_HARD_CAP;
  return Math.max(2, Math.min(COMPARE_HARD_CAP, n));
}

export interface CompareListEntry {
  productId: string;
  addedAt:   Date;
}

/** Return the user's current compare list (productIds + addedAt).
 *  Anonymous → cookie path. Authenticated → DB path. */
export async function listCompare(userId: string | null): Promise<CompareListEntry[]> {
  if (!userId) {
    const ids = readCompareCookie();
    // Synthesise an addedAt for cookie entries — order in the cookie is
    // already insertion order, so back-date by index.
    const now = Date.now();
    return ids.map((productId, i) => ({
      productId,
      addedAt: new Date(now - (ids.length - i) * 1000),
    }));
  }
  const rows = await prisma.compareItem.findMany({
    where:   { userId },
    orderBy: { addedAt: 'desc' },
    // PAGINATION-EXEMPT: bounded by COMPARE_HARD_CAP (4 rows).
    take:    COMPARE_HARD_CAP,
    select:  { productId: true, addedAt: true },
  });
  return rows;
}

/** Add a product. Idempotent — re-adding a product already in the list
 *  is a no-op (returns the unchanged list). Throws CompareListFullError
 *  on overflow with a NEW product. */
export async function addCompare(userId: string | null, productId: string): Promise<CompareListEntry[]> {
  await assertProductActive(productId);
  const max = await getMaxItems();

  if (!userId) {
    const current = readCompareCookie();
    if (current.includes(productId)) {
      log.info('compare.product_added', { userId: null, productId, listSize: current.length, idempotent: true });
      return listCompare(null);
    }
    if (current.length >= max) {
      log.warn('compare.list_full', { userId: null, productId, maxItems: max });
      throw new CompareListFullError(max);
    }
    const next = [...current, productId];
    writeCompareCookie(next);
    log.info('compare.product_added', { userId: null, productId, listSize: next.length });
    return listCompare(null);
  }

  // Authenticated path. Read current count, enforce cap, insert.
  const current = await prisma.compareItem.count({ where: { userId } });
  const existing = await prisma.compareItem.findUnique({
    where: { userId_productId: { userId, productId } },
    select: { id: true },
  });
  if (existing) {
    log.info('compare.product_added', { userId, productId, listSize: current, idempotent: true });
    return listCompare(userId);
  }
  if (current >= max) {
    log.warn('compare.list_full', { userId, productId, maxItems: max });
    throw new CompareListFullError(max);
  }
  await prisma.compareItem.create({ data: { userId, productId } });
  log.info('compare.product_added', { userId, productId, listSize: current + 1 });
  return listCompare(userId);
}

/** Remove a product. Idempotent — removing a missing product returns
 *  the unchanged list without throwing. */
export async function removeCompare(userId: string | null, productId: string): Promise<CompareListEntry[]> {
  if (!userId) {
    const next = readCompareCookie().filter((x) => x !== productId);
    writeCompareCookie(next);
    log.info('compare.product_removed', { userId: null, productId });
    return listCompare(null);
  }
  await prisma.compareItem.deleteMany({ where: { userId, productId } });
  log.info('compare.product_removed', { userId, productId });
  return listCompare(userId);
}

/** Clear the entire list. */
export async function clearCompare(userId: string | null): Promise<void> {
  if (!userId) {
    writeCompareCookie([]);
    log.info('compare.list_cleared', { userId: null });
    return;
  }
  await prisma.compareItem.deleteMany({ where: { userId } });
  log.info('compare.list_cleared', { userId });
}

/** Merge the local productIds into the user's server list. De-duplicates
 *  against existing rows and clips to `maxItems`. Used on login. */
export async function syncCompare(userId: string, localProductIds: string[]): Promise<CompareListEntry[]> {
  if (!Array.isArray(localProductIds)) {
    throw new ValidationError('localProductIds must be an array.');
  }
  // Validate every id and dedupe before any DB write.
  const cleaned = [...new Set(localProductIds.filter((x) => typeof x === 'string' && x.length > 0))]
    .slice(0, COMPARE_HARD_CAP);
  if (cleaned.length === 0) {
    return listCompare(userId);
  }
  // Validate every product is active. Drop unknown / inactive silently.
  // PAGINATION-EXEMPT: bounded by `cleaned.length` (max 4).
  const valid = await prisma.product.findMany({
    where:  { id: { in: cleaned }, isActive: true },
    select: { id: true },
  });
  const validIds = new Set(valid.map((p) => p.id));
  const toInsert = cleaned.filter((id) => validIds.has(id));

  const max = await getMaxItems();
  const before = await prisma.compareItem.count({ where: { userId } });
  const room = Math.max(0, max - before);
  const slice = toInsert.slice(0, room);

  // Pre-fetch the user's existing IDs so we can skip those without
  // triggering a P2002 (which Prisma prints to stderr even when we
  // catch the JS error — noisy in tests + logs).
  const existing = await prisma.compareItem.findMany({
    where: { userId, productId: { in: slice } },
    // PAGINATION-EXEMPT: bounded by `slice.length` (max 4).
    select: { productId: true },
  });
  const haveSet = new Set(existing.map((e) => e.productId));
  let added = 0;
  for (const productId of slice) {
    if (haveSet.has(productId)) continue;
    await prisma.compareItem.create({ data: { userId, productId } });
    added++;
  }
  const after = await prisma.compareItem.count({ where: { userId } });
  log.info('compare.list_synced', { userId, added, totalAfter: after });
  return listCompare(userId);
}

// ── Internals ────────────────────────────────────────────────────────────

async function assertProductActive(productId: string): Promise<void> {
  if (typeof productId !== 'string' || productId.length === 0) {
    throw new ValidationError('productId is required.');
  }
  const p = await prisma.product.findUnique({
    where:  { id: productId },
    select: { id: true, isActive: true },
  });
  if (!p) {
    log.warn('compare.invalid_product', { productId, reason: 'not_found' });
    throw new ValidationError('Unknown product.', { code: 'COMPARE_INVALID_PRODUCT' });
  }
  if (!p.isActive) {
    log.warn('compare.invalid_product', { productId, reason: 'inactive' });
    throw new ValidationError('Product is no longer available.', { code: 'COMPARE_INVALID_PRODUCT' });
  }
}

// ── Backwards-compatibility re-exports ───────────────────────────────────
//
// The previous implementation exported `toggleCompareCookie` — keep it
// alive as a thin wrapper so any straggling callers don't break during
// the migration. Marked `@deprecated`: new code should use `addCompare`
// / `removeCompare` (which speak both backends).

/** @deprecated Use {@link addCompare} / {@link removeCompare}. */
export function toggleCompareCookie(productId: string): { ids: string[]; included: boolean } {
  const current = readCompareCookie();
  if (current.includes(productId)) {
    const next = current.filter((x) => x !== productId);
    writeCompareCookie(next);
    return { ids: next, included: false };
  }
  if (current.length >= COMPARE_HARD_CAP) {
    return { ids: current, included: true };
  }
  const next = [...current, productId];
  writeCompareCookie(next);
  return { ids: next, included: true };
}
