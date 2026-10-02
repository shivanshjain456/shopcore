/**
 * Hero-banner service — Feature #15.
 *
 *   Single source of truth for reading + writing hero-carousel slides.
 *   The frontend carousel and the admin CRUD both go through this module,
 *   so any future change (caching, scheduling, A/B-test bucketing, multi-
 *   tenant) lands in one place.
 *
 *   Lifecycle helpers:
 *     - `listVisibleBanners(now)`  → only active + in-window rows, ordered
 *                                    by displayOrder ASC then createdAt DESC.
 *     - `listAllBanners()`         → admin view (every row, including drafts).
 *     - `getBannerById(id)`        → admin row read.
 *     - `createBanner(input, who)` → CRUD.
 *     - `updateBanner(id, input)`  → CRUD.
 *     - `deleteBanner(id)`         → hard delete (admin-only).
 *     - `reorderBanners(ids)`      → bulk displayOrder write.
 *
 *   Pure functions where possible — the only side effect is the Prisma call.
 *   No external requests, no caching here (the storefront uses the route's
 *   HTTP cache headers; admin reads are always live).
 */
import { prisma } from '@/lib/db/client';
import type { HeroBanner } from '@prisma/client';

/** Public-shape used by the frontend carousel. Stripped of audit columns. */
export interface HeroBannerView {
  id: string;
  headline: string;
  subheadline: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageDesktopUrl: string;
  imageMobileUrl: string | null;
  imageAlt: string | null;
  textColor: 'light' | 'dark' | null;
  overlayOpacity: number;
}

export function toView(b: HeroBanner): HeroBannerView {
  return {
    id: b.id,
    headline: b.headline,
    subheadline: b.subheadline,
    ctaLabel: b.ctaLabel,
    ctaHref: b.ctaHref,
    imageDesktopUrl: b.imageDesktopUrl,
    imageMobileUrl: b.imageMobileUrl,
    imageAlt: b.imageAlt,
    textColor: (b.textColor === 'light' || b.textColor === 'dark') ? b.textColor : null,
    overlayOpacity: clampPct(b.overlayOpacity),
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 35;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/**
 * Public list — only banners that should be visible to a shopper right now.
 *
 *   Rules:
 *     - isActive=true
 *     - startsAt is null OR startsAt ≤ now
 *     - endsAt   is null OR endsAt   ≥ now
 *
 *   Ordering: displayOrder ASC, then createdAt DESC as a tie-break.
 *
 *   We DO NOT cache in memory — the public route layer applies HTTP
 *   `Cache-Control` for the browser/CDN, which is the right level.
 */
export async function listVisibleBanners(now: Date = new Date()): Promise<HeroBannerView[]> {
  const rows = await prisma.heroBanner.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null },   { endsAt:   { gte: now } }] },
      ],
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(toView);
}

/** Admin list — every row, including drafts + expired. */
export async function listAllBanners() {
  return prisma.heroBanner.findMany({
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function getBannerById(id: string) {
  return prisma.heroBanner.findUnique({ where: { id } });
}

export interface HeroBannerCreateInput {
  name: string;
  headline: string;
  subheadline?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  imageDesktopUrl: string;
  imageMobileUrl?: string | null;
  imageAlt?: string | null;
  textColor?: 'light' | 'dark' | null;
  overlayOpacity?: number;
  isActive?: boolean;
  displayOrder?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export type HeroBannerUpdateInput = Partial<HeroBannerCreateInput>;

export async function createBanner(input: HeroBannerCreateInput, createdById?: string | null) {
  return prisma.heroBanner.create({
    data: {
      name:            input.name,
      headline:        input.headline,
      subheadline:     input.subheadline ?? null,
      ctaLabel:        input.ctaLabel ?? null,
      ctaHref:         input.ctaHref ?? null,
      imageDesktopUrl: input.imageDesktopUrl,
      imageMobileUrl:  input.imageMobileUrl ?? null,
      imageAlt:        input.imageAlt ?? null,
      textColor:       input.textColor ?? null,
      overlayOpacity:  clampPct(input.overlayOpacity ?? 35),
      isActive:        input.isActive ?? true,
      displayOrder:    Number.isFinite(input.displayOrder) ? Math.trunc(input.displayOrder!) : 0,
      startsAt:        input.startsAt ?? null,
      endsAt:          input.endsAt ?? null,
      createdById:     createdById ?? null,
      updatedById:     createdById ?? null,
    },
  });
}

export async function updateBanner(id: string, input: HeroBannerUpdateInput, updatedById?: string | null) {
  const data: Record<string, unknown> = {};
  if (input.name            !== undefined) data.name            = input.name;
  if (input.headline        !== undefined) data.headline        = input.headline;
  if (input.subheadline     !== undefined) data.subheadline     = input.subheadline;
  if (input.ctaLabel        !== undefined) data.ctaLabel        = input.ctaLabel;
  if (input.ctaHref         !== undefined) data.ctaHref         = input.ctaHref;
  if (input.imageDesktopUrl !== undefined) data.imageDesktopUrl = input.imageDesktopUrl;
  if (input.imageMobileUrl  !== undefined) data.imageMobileUrl  = input.imageMobileUrl;
  if (input.imageAlt        !== undefined) data.imageAlt        = input.imageAlt;
  if (input.textColor       !== undefined) data.textColor       = input.textColor;
  if (input.overlayOpacity  !== undefined) data.overlayOpacity  = clampPct(input.overlayOpacity);
  if (input.isActive        !== undefined) data.isActive        = input.isActive;
  if (input.displayOrder    !== undefined) data.displayOrder    = Math.trunc(input.displayOrder);
  if (input.startsAt        !== undefined) data.startsAt        = input.startsAt;
  if (input.endsAt          !== undefined) data.endsAt          = input.endsAt;
  if (updatedById)                         data.updatedById     = updatedById;
  return prisma.heroBanner.update({ where: { id }, data });
}

export async function deleteBanner(id: string): Promise<void> {
  await prisma.heroBanner.delete({ where: { id } });
}

/**
 * Bulk-write displayOrder so admins can drag-and-drop without firing N
 * separate PATCH requests. Runs as a single transaction so the order is
 * either fully applied or not at all.
 */
export async function reorderBanners(orderedIds: string[]): Promise<number> {
  if (orderedIds.length === 0) return 0;
  await prisma.$transaction(
    orderedIds.map((id, idx) =>
      prisma.heroBanner.update({ where: { id }, data: { displayOrder: idx } }),
    ),
  );
  return orderedIds.length;
}
