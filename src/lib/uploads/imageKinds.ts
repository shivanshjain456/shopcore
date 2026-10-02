/**
 * Image-kind registry — Item 17.
 *
 * Each kind defines:
 *   - the maximum upload size (MB),
 *   - the maximum re-encode dimensions (px),
 *   - the output format chosen by sharp (JPG or PNG — PNG for kinds
 *     that commonly use transparency, like logos and icons),
 *   - a human-readable purpose + recommended source dimensions for
 *     the admin upload UI.
 *
 * Adding a new kind = one entry here. The upload endpoint, the public
 * serving route, and the admin upload UI all read from this single
 * source of truth.
 *
 * Pure module — no Prisma / Next imports.
 */

export type AdminImageKind =
  | 'logo'
  | 'favicon'
  | 'og_image'
  | 'app_icon'
  | 'brand'
  | 'category'
  | 'category_banner'
  | 'category_icon'
  | 'hero'
  | 'promotion'
  // Item 19 — product gallery photography (front / rear / sides /
  // lifestyle / packaging shots). JPG at 90% quality, max 2400 px.
  | 'product'
  | 'misc';

export interface ImageKindSpec {
  /** Maximum upload size in megabytes. */
  maxMb:           number;
  /** Maximum re-encoded edge in pixels. Sharp `fit: 'inside'`. */
  maxPx:           number;
  /** Output format. PNG preserves transparency (logos / icons); JPG
   *  gives smaller files for photographic content (banners / OG). */
  outputFormat:    'jpg' | 'png';
  /** Quality (1-100) — applied to whichever format is chosen. */
  quality:         number;
  /** Human-readable copy shown next to the `<ImageUploadInput>`. */
  label:           string;
  /** "Recommended 400×400" hint shown in the upload UI. */
  recommendedHint: string;
}

/** The canonical registry. */
export const IMAGE_KIND_SPECS: Record<AdminImageKind, ImageKindSpec> = {
  // ── Store identity ────────────────────────────────────────────────
  logo: {
    maxMb: 2, maxPx: 800, outputFormat: 'png', quality: 100,
    label: 'Store logo',
    recommendedHint: 'PNG with transparent background, ~400×120 px.',
  },
  favicon: {
    maxMb: 1, maxPx: 256, outputFormat: 'png', quality: 100,
    label: 'Favicon',
    recommendedHint: 'Square PNG, 32×32 or 180×180 px.',
  },
  og_image: {
    maxMb: 2, maxPx: 1200, outputFormat: 'jpg', quality: 90,
    label: 'Open Graph image',
    recommendedHint: 'Exactly 1200×630 px JPG for best social-share quality.',
  },
  app_icon: {
    maxMb: 1, maxPx: 512, outputFormat: 'png', quality: 100,
    label: 'PWA app icon',
    recommendedHint: 'Square PNG, 512×512 px, no transparency around edges.',
  },

  // ── Catalogue ─────────────────────────────────────────────────────
  brand: {
    maxMb: 1, maxPx: 600, outputFormat: 'png', quality: 100,
    label: 'Brand logo',
    recommendedHint: 'Square PNG with transparent background, ~400×400 px.',
  },
  category: {
    maxMb: 2, maxPx: 1200, outputFormat: 'jpg', quality: 85,
    label: 'Category tile',
    recommendedHint: 'JPG, ~800×600 px (4:3 landscape).',
  },
  category_banner: {
    maxMb: 3, maxPx: 1920, outputFormat: 'jpg', quality: 85,
    label: 'Category banner',
    recommendedHint: 'Wide JPG, ~1600×400 px for full-width display.',
  },
  category_icon: {
    maxMb: 1, maxPx: 256, outputFormat: 'png', quality: 100,
    label: 'Category nav icon',
    recommendedHint: 'Square PNG, ~64×64 px with transparent background.',
  },

  // ── Marketing ─────────────────────────────────────────────────────
  hero: {
    maxMb: 5, maxPx: 2400, outputFormat: 'jpg', quality: 85,
    label: 'Hero banner',
    recommendedHint: 'JPG, ~1920×1080 px desktop / ~750×1000 px mobile variant.',
  },
  promotion: {
    maxMb: 3, maxPx: 1600, outputFormat: 'jpg', quality: 85,
    label: 'Promotion image',
    recommendedHint: 'JPG, ~1200×600 px.',
  },
  // ── Catalogue ─ Item 19 product gallery ─────────────────────────────
  product: {
    // Product photography is the showcase asset of the entire catalogue.
    // 5 MB ceiling lets agencies upload 24-MP DSLR shots without
    // pre-processing; sharp downsizes to 2400 px (handles 4K displays
    // + the Item-20 zoom interaction headroom) at q90 (visibly
    // indistinguishable from q100 while typically shaving 40-60 % of
    // the bytes).
    maxMb: 5, maxPx: 2400, outputFormat: 'jpg', quality: 90,
    label: 'Product photo',
    recommendedHint: 'JPG, ~2000×2000 px square recommended (works for grid + lightbox zoom).',
  },
  misc: {
    maxMb: 2, maxPx: 2400, outputFormat: 'jpg', quality: 85,
    label: 'Miscellaneous',
    recommendedHint: 'JPG or PNG, any reasonable size.',
  },
};

export const ADMIN_IMAGE_KINDS = Object.keys(IMAGE_KIND_SPECS) as readonly AdminImageKind[];

export function isAdminImageKind(s: unknown): s is AdminImageKind {
  return typeof s === 'string' && (ADMIN_IMAGE_KINDS as readonly string[]).includes(s);
}

export function getImageKindSpec(kind: AdminImageKind): ImageKindSpec {
  return IMAGE_KIND_SPECS[kind];
}
