/**
 * Zod schemas for the hero-banner CMS — Feature #15.
 *
 *   These are reused by the admin POST + PATCH routes AND the bulk-reorder
 *   endpoint. Validation lives here so the route handlers stay thin and so
 *   the same rules apply if a future flow (Excel import, scheduled
 *   automation) wants to write banners without touching HTTP.
 */
import { z } from 'zod';

const trimmed = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required.`).max(max, `${label} is too long.`);

// A URL or app-relative path. We accept either so admins can paste full
// `https://cdn…/foo.jpg` URLs OR project-relative `/uploads/hero/foo.jpg`.
const urlOrPath = z.string().trim().min(1).max(2000).regex(
  /^(?:https?:\/\/|\/)/,
  'Image URL must start with http(s):// or /.',
);

// Same for CTA target — accept absolute URL or in-app path.
const linkUrl = z.string().trim().min(1).max(2000).regex(
  /^(?:https?:\/\/|\/|mailto:|tel:)/,
  'Link must start with http(s)://, /, mailto:, or tel:.',
).optional().nullable();

const dateOrNull = z.union([
  z.string().datetime().transform((s) => new Date(s)),
  z.date(),
  z.null(),
]);

export const HeroBannerCreateSchema = z.object({
  name:            trimmed(1, 120, 'Internal name'),
  headline:        trimmed(1, 160, 'Headline'),
  subheadline:     trimmed(0, 280, 'Subheadline').optional().nullable(),
  ctaLabel:        trimmed(0, 60,  'CTA label').optional().nullable(),
  ctaHref:         linkUrl,
  imageDesktopUrl: urlOrPath,
  imageMobileUrl:  urlOrPath.optional().nullable(),
  imageAlt:        trimmed(0, 200, 'Image alt text').optional().nullable(),
  textColor:       z.enum(['light', 'dark']).optional().nullable(),
  overlayOpacity:  z.number().int().min(0).max(100).optional(),
  isActive:        z.boolean().optional(),
  displayOrder:    z.number().int().min(0).max(10_000).optional(),
  startsAt:        dateOrNull.optional(),
  endsAt:          dateOrNull.optional(),
}).strict()
  .superRefine((v, ctx) => {
    // CTA label + href must be set together (you can't link without a
    // visible button label and you can't display a button that goes nowhere).
    const hasLabel = v.ctaLabel != null && String(v.ctaLabel).trim().length > 0;
    const hasHref  = v.ctaHref  != null && String(v.ctaHref).trim().length > 0;
    if (hasLabel !== hasHref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CTA label and CTA link must be provided together (or both omitted).',
        path: ['ctaLabel'],
      });
    }
    // If both dates are set, startsAt must precede endsAt.
    if (v.startsAt && v.endsAt && v.startsAt instanceof Date && v.endsAt instanceof Date) {
      if (v.startsAt.getTime() >= v.endsAt.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endsAt must be after startsAt.',
          path: ['endsAt'],
        });
      }
    }
  });

export type HeroBannerCreateInput = z.infer<typeof HeroBannerCreateSchema>;

// Update schema — every field optional, but same constraint coupling.
export const HeroBannerUpdateSchema = z.object({
  name:            trimmed(1, 120, 'Internal name').optional(),
  headline:        trimmed(1, 160, 'Headline').optional(),
  subheadline:     trimmed(0, 280, 'Subheadline').optional().nullable(),
  ctaLabel:        trimmed(0, 60,  'CTA label').optional().nullable(),
  ctaHref:         linkUrl,
  imageDesktopUrl: urlOrPath.optional(),
  imageMobileUrl:  urlOrPath.optional().nullable(),
  imageAlt:        trimmed(0, 200, 'Image alt text').optional().nullable(),
  textColor:       z.enum(['light', 'dark']).optional().nullable(),
  overlayOpacity:  z.number().int().min(0).max(100).optional(),
  isActive:        z.boolean().optional(),
  displayOrder:    z.number().int().min(0).max(10_000).optional(),
  startsAt:        dateOrNull.optional(),
  endsAt:          dateOrNull.optional(),
}).strict();

export const HeroBannerReorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
}).strict();
