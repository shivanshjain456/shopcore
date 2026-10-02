/**
 * Product gallery service — Item 19.
 *
 *   Single source of truth for CRUD over `ProductImage` rows. The admin
 *   API routes are thin wrappers around this module; the storefront
 *   read path calls `listGalleryForPdp()` which returns ONLY active
 *   images in display order. Every admin mutation enforces the
 *   "exactly one primary" invariant.
 *
 *   Public surface:
 *     - listGalleryForAdmin(productId)        — every row, incl. inactive
 *     - listGalleryForPdp(productId)          — active rows, ordered
 *     - countGallery(productId)               — used by store-config cap
 *     - registerImage(productId, url, alt?)   — record a new uploaded URL
 *     - updateImage(id, patch)                — alt / isActive / sortOrder
 *     - setPrimary(productId, imageId)        — exactly-one-primary
 *     - reorderImages(productId, orderedIds)  — atomic 10-step renumber
 *     - deleteImage(id)                       — idempotent
 *
 *   Validation is strict — every public function throws ValidationError /
 *   NotFoundError on bad input. The admin API translates those into the
 *   standard ShopCore JSON envelopes.
 */
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { ValidationError, NotFoundError } from '@/lib/errors';
import { getStoreConfig } from '@/lib/storeConfig';

// ── Types ────────────────────────────────────────────────────────────────

export interface ProductImageRow {
  id:         string;
  productId:  string;
  url:        string;
  alt:        string | null;
  sortOrder:  number;
  isPrimary:  boolean;
  isActive:   boolean;
  createdAt:  Date;
  updatedAt:  Date;
}

export interface UpdateImagePatch {
  alt?:       string | null;
  isActive?:  boolean;
  sortOrder?: number;
}

// ── Validation helpers ───────────────────────────────────────────────────

const URL_MAX = 500;
const ALT_MAX = 200;

function trimUrl(raw: string): string {
  const t = String(raw ?? '').trim();
  if (!t) throw new ValidationError('Image URL is required.', { code: 'PRODUCT_IMAGE_URL_REQUIRED' });
  if (t.length > URL_MAX) {
    throw new ValidationError(`Image URL too long (max ${URL_MAX} chars).`, { code: 'PRODUCT_IMAGE_URL_TOO_LONG' });
  }
  return t;
}

function trimAlt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t) return null;
  if (t.length > ALT_MAX) {
    throw new ValidationError(`Alt text too long (max ${ALT_MAX} chars).`, { code: 'PRODUCT_IMAGE_ALT_TOO_LONG' });
  }
  return t;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function listGalleryForAdmin(productId: string): Promise<ProductImageRow[]> {
  // PAGINATION-EXEMPT: gallery is admin-capped (max 40, default 12).
  const rows = await prisma.productImage.findMany({
    where: { productId },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(serialize);
}

export async function listGalleryForPdp(productId: string): Promise<ProductImageRow[]> {
  // PAGINATION-EXEMPT: gallery is admin-capped (max 40).
  const rows = await prisma.productImage.findMany({
    where: { productId, isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(serialize);
}

export async function countGallery(productId: string): Promise<number> {
  return prisma.productImage.count({ where: { productId } });
}

// ── Writes ───────────────────────────────────────────────────────────────

/** Register a freshly-uploaded URL as a new gallery row.
 *
 *   Enforces:
 *     - cap from `products.maxGalleryImages` store config,
 *     - default `sortOrder` = (current max + 10),
 *     - first image of a product auto-becomes primary,
 *     - non-first uploads default to non-primary + active.
 */
export async function registerImage(input: {
  productId: string;
  url:       string;
  alt?:      string | null;
  isActive?: boolean;
}): Promise<ProductImageRow> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId }, select: { id: true },
  });
  if (!product) throw new NotFoundError('Product not found.');

  const url = trimUrl(input.url);
  const alt = trimAlt(input.alt);

  // Enforce per-product cap from store config.
  const [count, cfg] = await Promise.all([
    countGallery(input.productId),
    getStoreConfig(),
  ]);
  const max = readMaxGalleryImages(cfg);
  if (count >= max) {
    throw new ValidationError(
      `This product already has the maximum number of images (${max}). Remove one before uploading another.`,
      { code: 'PRODUCT_GALLERY_LIMIT_REACHED', context: { count, max } },
    );
  }

  // Default the sortOrder to "after every existing row".
  const top = await prisma.productImage.aggregate({
    where: { productId: input.productId },
    _max:  { sortOrder: true },
  });
  const nextOrder = (top._max.sortOrder ?? 0) + 10;

  // First-ever image auto-promotes to primary so cards / wishlist /
  // search / cart always have something to render even if the admin
  // never explicitly sets a primary.
  const isPrimary = count === 0;

  const created = await prisma.productImage.create({
    data: {
      productId:  input.productId,
      url,
      alt,
      sortOrder:  nextOrder,
      isPrimary,
      isActive:   input.isActive !== false,
    },
  });
  return serialize(created);
}

export async function updateImage(id: string, patch: UpdateImagePatch): Promise<ProductImageRow> {
  const existing = await prisma.productImage.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Image not found.');

  const data: Record<string, unknown> = {};
  if (patch.alt       !== undefined) data.alt       = trimAlt(patch.alt);
  if (patch.isActive  !== undefined) data.isActive  = !!patch.isActive;
  if (patch.sortOrder !== undefined) {
    const n = Math.floor(Number(patch.sortOrder));
    if (!Number.isFinite(n) || n < 0) {
      throw new ValidationError('sortOrder must be a non-negative integer.', { code: 'PRODUCT_IMAGE_BAD_ORDER' });
    }
    data.sortOrder = n;
  }
  const updated = await prisma.productImage.update({ where: { id }, data });

  // Special case: if we just soft-disabled the current primary, promote
  // the next active image so non-PDP surfaces still have something.
  if (patch.isActive === false && existing.isPrimary) {
    await ensurePrimary(existing.productId);
  }
  return serialize(updated);
}

/** Exactly-one-primary: flips the chosen image to primary AND every
 *  other image of the product to non-primary, in one transaction. */
export async function setPrimary(productId: string, imageId: string): Promise<ProductImageRow> {
  const target = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!target || target.productId !== productId) {
    throw new NotFoundError('Image not found for this product.');
  }
  if (!target.isActive) {
    throw new ValidationError('Cannot set a disabled image as primary. Enable it first.', {
      code: 'PRODUCT_IMAGE_INACTIVE_PRIMARY',
    });
  }
  await prisma.$transaction([
    prisma.productImage.updateMany({
      where: { productId, NOT: { id: imageId } },
      data:  { isPrimary: false },
    }),
    prisma.productImage.update({
      where: { id: imageId },
      data:  { isPrimary: true },
    }),
  ]);
  const updated = await prisma.productImage.findUnique({ where: { id: imageId } });
  return serialize(updated!);
}

/** Atomic reorder: assigns sortOrder 10/20/30/… to the supplied id list
 *  IN ORDER. Ids not in the list keep their existing order and slot at
 *  the tail. Unknown ids are silently dropped. */
export async function reorderImages(productId: string, orderedIds: string[]): Promise<void> {
  // PAGINATION-EXEMPT: admin-capped.
  const existing = await prisma.productImage.findMany({
    where: { productId }, select: { id: true, sortOrder: true },
  });
  const knownIds = new Set(existing.map((r) => r.id));
  const valid = orderedIds.filter((id) => knownIds.has(id));
  const seen  = new Set(valid);
  const tail  = existing
    .filter((r) => !seen.has(r.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.id);
  const final = [...valid, ...tail];
  await prisma.$transaction(
    final.map((id, idx) =>
      prisma.productImage.update({
        where: { id },
        data:  { sortOrder: (idx + 1) * 10 },
      }),
    ),
  );
}

/** Idempotent delete. If the deleted row was primary, promote the
 *  next active image to keep the exactly-one-primary invariant. */
export async function deleteImage(id: string): Promise<void> {
  const existing = await prisma.productImage.findUnique({ where: { id } });
  if (!existing) return;
  await prisma.productImage.delete({ where: { id } });
  if (existing.isPrimary) {
    await ensurePrimary(existing.productId);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** Promote the first active image to primary if no primary currently
 *  exists. No-op if the product still has a primary OR has no images. */
async function ensurePrimary(productId: string): Promise<void> {
  const current = await prisma.productImage.findFirst({
    where: { productId, isPrimary: true },
  });
  if (current) return;
  const next = await prisma.productImage.findFirst({
    where: { productId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  if (!next) return;
  await prisma.productImage.update({
    where: { id: next.id }, data: { isPrimary: true },
  });
  log.info('product.image.primary_promoted', {
    productId, imageId: next.id,
  });
}

function serialize(r: {
  id: string; productId: string; url: string; alt: string | null;
  sortOrder: number; isPrimary: boolean; isActive: boolean;
  createdAt: Date; updatedAt: Date;
}): ProductImageRow {
  return {
    id: r.id, productId: r.productId, url: r.url, alt: r.alt,
    sortOrder: r.sortOrder, isPrimary: r.isPrimary, isActive: r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** Pull the admin-configured cap from store config with a hard
 *  ceiling at 40 (defensive: the admin schema validates 1-40 too,
 *  but if anyone bypasses that we'd rather refuse the write). */
function readMaxGalleryImages(cfg: unknown): number {
  const root = cfg as Record<string, unknown>;
  const products = (root.products as Record<string, unknown> | undefined) ?? {};
  const raw = products.maxGalleryImages;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 12;
  return Math.max(1, Math.min(40, n));
}

/** Read the master gallery feature flag from store config. */
export function isGalleryEnabled(cfg: unknown): boolean {
  const root = cfg as Record<string, unknown>;
  const products = (root.products as Record<string, unknown> | undefined) ?? {};
  const raw = products.galleryEnabled;
  return raw === undefined ? true : raw === true;
}

/** Read the lazy-load flag from store config. */
export function isGalleryLazyLoadEnabled(cfg: unknown): boolean {
  const root = cfg as Record<string, unknown>;
  const products = (root.products as Record<string, unknown> | undefined) ?? {};
  const raw = products.galleryLazyLoadEnabled;
  return raw === undefined ? true : raw === true;
}

// ── Item 20 — interaction-layer config readers ──────────────────────────

/** Snapshot of every interaction-layer knob the storefront gallery
 *  needs. The PDP reads this ONCE on the server and passes the whole
 *  object down to the client gallery as a prop. */
export interface GalleryInteractionSettings {
  /** Master switch for click / swipe / keyboard interactions. */
  interactionsEnabled: boolean;
  /** Hover / tap-to-zoom on the main image. */
  zoomEnabled:         boolean;
  /** "View fullscreen" affordance + lightbox. */
  fullscreenEnabled:   boolean;
  /** When true, Next at the last image wraps to the first. */
  loopEnabled:         boolean;
  /** Fade duration in ms when swapping the main image. 0 disables.
   *  `prefers-reduced-motion` always wins regardless of this number. */
  transitionMs:        number;
  /** Where the thumbnail rail sits on desktop. Mobile is always
   *  bottom regardless. */
  thumbnailPosition:   'bottom' | 'left';
}

function readBoolDefaultTrue(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  return v === undefined ? true : v === true;
}

function readBoolDefaultFalse(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  return v === undefined ? false : v === true;
}

export function readGalleryInteractionSettings(cfg: unknown): GalleryInteractionSettings {
  const root = cfg as Record<string, unknown>;
  const products = (root.products as Record<string, unknown> | undefined) ?? {};

  const rawMs = products.galleryTransitionMs;
  const transitionMs = Math.max(0, Math.min(500, Math.floor(
    typeof rawMs === 'number' && Number.isFinite(rawMs) ? rawMs : 150,
  )));

  const rawPos = typeof products.galleryThumbnailPosition === 'string'
    ? products.galleryThumbnailPosition : 'bottom';
  const thumbnailPosition: 'bottom' | 'left' = rawPos === 'left' ? 'left' : 'bottom';

  return {
    interactionsEnabled: readBoolDefaultTrue(products,  'galleryInteractionsEnabled'),
    zoomEnabled:         readBoolDefaultTrue(products,  'galleryZoomEnabled'),
    fullscreenEnabled:   readBoolDefaultTrue(products,  'galleryFullscreenEnabled'),
    loopEnabled:         readBoolDefaultFalse(products, 'galleryLoopEnabled'),
    transitionMs,
    thumbnailPosition,
  };
}
