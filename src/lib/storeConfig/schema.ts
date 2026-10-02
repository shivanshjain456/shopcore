/**
 * Store Config Schema — the typed, dot-key inventory of every admin-tunable
 * setting in ShopCore. Spec §2.2.
 *
 * Discipline:
 *   - Every entry has: label, description, category, section, default,
 *     and a Zod validator.
 *   - No setting is added anywhere else in the codebase. New toggles are
 *     a single-file change here (plus a handler check at the point of
 *     use).
 *   - Types are DERIVED from this schema (see `types.ts`) — there is no
 *     separate type definition that could drift.
 *
 * The schema is a flat `Record<string, ConfigEntry>` keyed by dot path
 * (`features.b2bEnabled`). The reader (`getStoreConfig`) re-builds a
 * nested object for ergonomic access at use-sites.
 */
import { z, type ZodTypeAny } from 'zod';
import type { JobType } from '@/lib/jobs/jobTypes';
import { JOB_TYPES } from '@/lib/jobs/jobTypes';
// Item 9: canonical Indian-phone normaliser (single source of truth).
import { normalisePhone } from '@/lib/utils/phone';

// ── Categories ────────────────────────────────────────────────────────────

export const CONFIG_CATEGORIES = [
  'store',         // Store identity, contact, hours
  'features',      // Feature toggles (on/off switches)
  'products',      // Item 19 — product catalogue + gallery knobs
  'payments',      // Payment configuration
  'shipping',      // Shipping rules and thresholds
  'checkout',      // Checkout behaviour
  'loyalty',       // Loyalty program settings
  'b2b',           // B2B portal settings
  'notifications', // Email and SMS notification settings
  'security',      // Security policies
  'performance',   // Caching and performance
  'maintenance',   // Maintenance mode and operational controls
] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

// ── Entry shape ───────────────────────────────────────────────────────────

export type ConfigType = 'boolean' | 'number' | 'string' | 'enum' | 'json';

export interface ConfigEntry<T> {
  /** Dot-notation key — must match the object property in CONFIG_SCHEMA. */
  key:               string;
  type:              ConfigType;
  default:           T;
  label:             string;
  description:       string;
  category:          ConfigCategory;
  section:           string;
  /** Zod validator. Required — at minimum echoes the type. We use the
   *  broad `ZodTypeAny` here (rather than `ZodSchema<T>`) because
   *  `.default(...)` wraps the schema in `ZodDefault`, which widens
   *  the input type to include `undefined` — incompatible with the
   *  output-narrow `ZodSchema<T>` constraint. The `_typeCheck`
   *  helper below enforces output-type alignment at compile time. */
  validation:        ZodTypeAny;
  /** True when changing this value requires restarting the Node process
   *  to take effect (e.g., a value baked into module-level state). The
   *  admin UI shows a "Requires Restart" badge. */
  requiresRestart?:  boolean;
  /** UI warning level. `caution` shows amber; `danger` requires a
   *  per-field "I understand" confirmation before edit. */
  dangerLevel?:      'safe' | 'caution' | 'danger';
  /** Enum-only — labelled option list for the admin <select>. */
  enumOptions?:      readonly { value: string; label: string }[];
  /** Job types to enqueue immediately when this value changes. The
   *  PATCH handler dedupes, then enqueues with priority 1. */
  affectsJobs?:      readonly JobType[];
  /** Optional UI-renderer hint for `string`-typed entries. The default
   *  `string` renderer is a plain `<input type="text">`. Set
   *  `fieldType: 'phone'` to swap in `<PhoneField>` (locked +91 prefix,
   *  digit-only input). Other values reserved for future use. */
  fieldType?:        'phone' | 'email' | 'url' | 'textarea'
                   // Item 17 — `image:<kind>` swaps in <ImageUploadInput>
                   //   with the matching upload kind, e.g. `image:logo`.
                   | `image:${string}`;
}

// ── Validators reused below ───────────────────────────────────────────────

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
// Indian state list (29 states + 8 UTs). Kept here rather than imported
// from shipping/serviceableStates.ts so the schema is self-contained.
const INDIAN_STATES: readonly string[] = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh',
  'Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka',
  'Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram',
  'Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana',
  'Tripura','Uttar Pradesh','Uttarakhand','West Bengal',
  'Andaman and Nicobar Islands','Chandigarh','Dadra and Nagar Haveli and Daman and Diu',
  'Delhi','Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry',
];

const optionalGstin = z.string().refine(
  (s) => s === '' || GSTIN_RE.test(s),
  { message: 'Must be a valid 15-character GSTIN (or empty).' },
);
const optionalPan = z.string().refine(
  (s) => s === '' || PAN_RE.test(s),
  { message: 'Must be a valid 10-character PAN (or empty).' },
);
const ipString = z.string().regex(
  // Accept IPv4 + IPv6 (loose) + CIDR notation. The admin uses this to
  // whitelist office IPs; an over-strict regex causes false rejections.
  /^[0-9a-fA-F.:]+(\/\d{1,3})?$/,
  { message: 'Must look like an IP address (v4, v6, or CIDR).' },
);

// Helper to compose a Zod schema from a plain primitive default.
function bool(d: boolean): ZodTypeAny { return z.boolean().default(d); }
function num(d: number, opts: { min?: number; max?: number; int?: boolean } = {}): ZodTypeAny {
  let s: z.ZodNumber = z.number();
  if (opts.int) s = s.int();
  if (opts.min !== undefined) s = s.min(opts.min);
  if (opts.max !== undefined) s = s.max(opts.max);
  return s.default(d);
}
function str(d: string, opts: { max?: number } = {}): ZodTypeAny {
  let s: z.ZodString = z.string();
  if (opts.max !== undefined) s = s.max(opts.max);
  return s.default(d);
}
function enumOf<E extends readonly [string, ...string[]]>(values: E, d: E[number]): ZodTypeAny {
  return z.enum(values).default(d);
}

// Helper to build a typed entry. Forces the default's type to match
// the validator's inferred type at compile time.
function entry<T>(e: ConfigEntry<T>): ConfigEntry<T> { return e; }

// ── The schema ────────────────────────────────────────────────────────────
//
// Every dot-key in CONFIG_SCHEMA is a top-level admin-tunable setting.
// Adding a new key here is the ONLY change needed to surface it in the
// admin UI and `getStoreConfig()`.
//
// Boolean defaults err on the SAFE side (existing-behaviour preserving):
//   - Things the platform already does → default true
//   - Things not yet built (promotions, quickView, recentlyViewed, AI) → false
//   - Maintenance/pause toggles → false (off)

export const CONFIG_SCHEMA = {
  // ─── store ──────────────────────────────────────────────────────────────
  'store.name':           entry({ key: 'store.name', type: 'string',
    default: 'ShopCore', validation: str('ShopCore', { max: 120 }),
    label: 'Store name', description: 'Display name shown across the storefront and emails.',
    category: 'store', section: 'Identity' }),
  'store.tagline':        entry({ key: 'store.tagline', type: 'string',
    default: '', validation: str('', { max: 200 }),
    label: 'Tagline', description: 'Short tagline shown in the header / footer.',
    category: 'store', section: 'Identity' }),
  'store.supportEmail':   entry({ key: 'store.supportEmail', type: 'string',
    default: '', validation: z.string().refine((s) => s === '' || z.string().email().safeParse(s).success,
      { message: 'Must be a valid email or empty.' }).default(''),
    label: 'Support email', description: 'Customer-facing support email address.',
    category: 'store', section: 'Contact' }),
  'store.supportPhone':   entry({ key: 'store.supportPhone', type: 'string',
    // Item 9 — normalise on the way IN. Permissive input (bare digits,
    // spaces, dashes, leading 0, +91 …) is normalised to canonical
    // E.164. Empty string is allowed (the field is optional).
    default: '',
    validation: z.string()
      .transform((s) => {
        if (s === '' || s.trim() === '') return '';
        return normalisePhone(s) ?? s;   // null → keep raw so refine fails
      })
      .refine((s) => s === '' || /^\+91[6-9]\d{9}$/.test(s),
        { message: 'Enter a valid 10-digit Indian mobile number, or leave empty.' })
      .default(''),
    label: 'Support phone', description: 'Customer-facing support phone number.',
    category: 'store', section: 'Contact',
    // Render with <PhoneField> in the admin UI instead of a plain text input.
    fieldType: 'phone' }),
  'store.address':        entry({ key: 'store.address', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Address', description: 'Physical address printed on invoices.',
    category: 'store', section: 'Identity' }),
  'store.gstin':          entry({ key: 'store.gstin', type: 'string',
    default: '', validation: optionalGstin.default(''),
    label: 'Store GSTIN', description: '15-char GSTIN printed on invoices.',
    category: 'store', section: 'Compliance' }),
  'store.pan':            entry({ key: 'store.pan', type: 'string',
    default: '', validation: optionalPan.default(''),
    label: 'Store PAN', description: '10-char PAN printed on invoices.',
    category: 'store', section: 'Compliance' }),
  'store.currencySymbol': entry({ key: 'store.currencySymbol', type: 'string',
    default: '₹', validation: str('₹', { max: 8 }),
    label: 'Currency symbol', description: 'Currency symbol shown across the storefront. ShopCore is INR-only — change only for cosmetic preference.',
    category: 'store', section: 'Identity' }),
  'store.timezone':       entry({ key: 'store.timezone', type: 'string',
    default: 'Asia/Kolkata', validation: str('Asia/Kolkata', { max: 64 }),
    label: 'Timezone', description: 'IANA timezone for date display.',
    category: 'store', section: 'Identity', requiresRestart: true }),
  // ── Item 17 — every store-identity asset is configurable from the
  //   admin store-config UI via <ImageUploadInput>. The `fieldType:
  //   'image:<kind>'` hint tells the schema-driven renderer to swap
  //   the plain `<input>` for the image uploader bound to the matching
  //   upload kind (see src/lib/uploads/imageKinds.ts).
  'store.logoUrl':        entry({ key: 'store.logoUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Store logo', description: 'Header logo. Upload a transparent PNG ~400×120 px.',
    category: 'store', section: 'Identity',
    fieldType: 'image:logo' }),
  'store.logoDarkUrl':    entry({ key: 'store.logoDarkUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Store logo (dark mode)', description: 'Optional. Shown on dark backgrounds when set.',
    category: 'store', section: 'Identity',
    fieldType: 'image:logo' }),
  'store.logoAlt':        entry({ key: 'store.logoAlt', type: 'string',
    default: '', validation: str('', { max: 200 }),
    label: 'Logo alt text', description: 'Screen-reader alt for the logo. Defaults to the store name when empty.',
    category: 'store', section: 'Identity' }),
  'store.faviconUrl':     entry({ key: 'store.faviconUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Favicon', description: 'Square PNG, 32×32 or 180×180 px. Falls back to a generated SVG of the store initial.',
    category: 'store', section: 'Identity',
    fieldType: 'image:favicon' }),
  'store.ogImageUrl':     entry({ key: 'store.ogImageUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Open Graph image', description: 'Shown when a ShopCore URL is shared on WhatsApp / Facebook / Twitter. 1200×630 JPG works best.',
    category: 'store', section: 'Identity',
    fieldType: 'image:og_image' }),
  'store.appIconUrl':     entry({ key: 'store.appIconUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'PWA app icon', description: 'Square PNG, 512×512 px. Used by browsers when customers "Add to Home Screen".',
    category: 'store', section: 'Identity',
    fieldType: 'image:app_icon' }),

  // ─── features ───────────────────────────────────────────────────────────
  'features.registrationEnabled':       entry({ key: 'features.registrationEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Customer registration', description: 'Allow new customers to create accounts.',
    category: 'features', section: 'Account & Identity', dangerLevel: 'caution' }),
  'features.guestCheckout':             entry({ key: 'features.guestCheckout', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Guest checkout', description: 'Allow customers to place orders without an account.',
    category: 'features', section: 'Account & Identity' }),
  'features.emailAuthEnabled':          entry({ key: 'features.emailAuthEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Email + password login', description: 'Allow customers to sign in with email + password.',
    category: 'features', section: 'Account & Identity', dangerLevel: 'danger' }),
  'features.phoneAuthEnabled':          entry({ key: 'features.phoneAuthEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Phone OTP login', description: 'Allow customers to sign in with phone OTP.',
    category: 'features', section: 'Account & Identity', dangerLevel: 'caution' }),
  'features.phoneVerificationRequired': entry({ key: 'features.phoneVerificationRequired', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Require phone verification', description: 'New accounts must complete phone OTP before unlocking ordering / write surfaces.',
    category: 'features', section: 'Account & Identity', dangerLevel: 'caution' }),
  'features.wishlistEnabled':           entry({ key: 'features.wishlistEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Wishlist', description: 'Enable the wishlist feature.',
    category: 'features', section: 'Customer experience' }),
  'features.compareEnabled':            entry({ key: 'features.compareEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Product comparison', description: 'Enable side-by-side product comparison.',
    category: 'features', section: 'Customer experience' }),

  // Item 18 — homepage CMS controls. Master switch + granular gates.
  //   Sections also each carry their own isActive flag in the
  //   HomepageSection table, but feature flags let the admin disable
  //   an entire CATEGORY of sections without touching every row.
  'features.homepageRevampEnabled':     entry({ key: 'features.homepageRevampEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'New CMS homepage', description: 'Use the admin-configurable homepage composition (Item 18). Disable to fall back to the legacy hand-coded layout.',
    category: 'features', section: 'Homepage' }),
  'features.homepageBrandsEnabled':     entry({ key: 'features.homepageBrandsEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Brand sections',  description: 'Show FEATURED_BRANDS / BRAND_SHOWCASE sections on the homepage.',
    category: 'features', section: 'Homepage' }),
  'features.homepageMetricsEnabled':    entry({ key: 'features.homepageMetricsEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Trust metrics',   description: 'Show STORE_METRICS section on the homepage.',
    category: 'features', section: 'Homepage' }),
  'features.homepageBranchesEnabled':   entry({ key: 'features.homepageBranchesEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Branches section',description: 'Show BRANCHES (physical store locations) section on the homepage.',
    category: 'features', section: 'Homepage' }),

  // Item 14 — compare list cap. Hard-capped at 4 in code regardless of
  // what the admin sets (the 4-column layout breaks beyond that on most
  // viewports). Configurable in the 2–4 range so admins can dial it
  // down without code changes.
  'compare.maxItems':                   entry({ key: 'compare.maxItems', type: 'number',
    default: 4, validation: num(4, { int: true, min: 2, max: 4 }),
    label: 'Max compare items', description: 'Maximum products in a single compare list. Hard ceiling is 4 (layout constraint).',
    category: 'features', section: 'Compare' }),

  // ── Item 19 — Product Gallery ──────────────────────────────────────────
  //
  //   Three knobs control the PDP gallery:
  //     - galleryEnabled         — master kill-switch. When OFF the PDP
  //                                renders only the primary image (no
  //                                thumb rail) and the admin manager
  //                                still works (so admins can curate
  //                                photography behind the scenes before
  //                                flipping the switch on).
  //     - maxGalleryImages       — per-product cap. Defended at the
  //                                service layer (`registerImage`); the
  //                                schema enforces 1-40 here too.
  //     - galleryLazyLoadEnabled — secondary images load with
  //                                `loading="lazy"` + `decoding="async"`.
  //                                Disable for stores whose customers
  //                                expect instant thumb cycling on
  //                                slow networks (rare).
  'products.galleryEnabled':            entry({ key: 'products.galleryEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Product gallery', description: 'Show the multi-image gallery on every product detail page. When off, the PDP renders only the primary image.',
    category: 'products', section: 'Gallery' }),
  'products.maxGalleryImages':          entry({ key: 'products.maxGalleryImages', type: 'number',
    default: 12, validation: num(12, { int: true, min: 1, max: 40 }),
    label: 'Max gallery images', description: 'Maximum number of images per product. Hard ceiling is 40 (storefront grid + performance constraint).',
    category: 'products', section: 'Gallery' }),
  'products.galleryLazyLoadEnabled':    entry({ key: 'products.galleryLazyLoadEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Lazy-load secondary images', description: 'Defer loading of non-primary gallery images until they enter the viewport. Recommended for performance.',
    category: 'products', section: 'Gallery' }),

  // ── Item 20 — Product Gallery Interaction ──────────────────────────────
  //
  //   Six knobs control the interactive PDP gallery experience:
  //     - galleryInteractionsEnabled — master kill-switch. When OFF the
  //                                    gallery reverts to the static
  //                                    Item-19 rendering (no JS-driven
  //                                    image switching, no zoom, no
  //                                    fullscreen). Customers still see
  //                                    every image; they just can't
  //                                    click thumbs to swap the main.
  //     - galleryZoomEnabled         — hover/tap-to-zoom on the main
  //                                    image. Pure-CSS `transform:
  //                                    scale()` — no heavy libs.
  //     - galleryFullscreenEnabled   — opens the image in a focus-trapped
  //                                    fullscreen lightbox (native
  //                                    <dialog>.showModal so a11y is free).
  //     - galleryLoopEnabled         — when ON, Next at last → first
  //                                    (Amazon-style stops at the end by
  //                                    default; Flipkart-style loops).
  //     - galleryTransitionMs        — fade duration on image swap.
  //                                    Capped at 500 ms — `prefers-
  //                                    reduced-motion` ALWAYS wins and
  //                                    sets it to 0 regardless of config.
  //     - galleryThumbnailPosition   — bottom (default — most common)
  //                                    or left (Apple-store style on
  //                                    desktop; folds back to bottom on
  //                                    mobile where vertical real estate
  //                                    is precious).
  'products.galleryInteractionsEnabled': entry({ key: 'products.galleryInteractionsEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Interactive gallery', description: 'Master switch for the interactive gallery (click-to-swap, swipe, keyboard navigation). When off the storefront falls back to a static gallery.',
    category: 'products', section: 'Gallery interaction' }),
  'products.galleryZoomEnabled':         entry({ key: 'products.galleryZoomEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Image zoom', description: 'Allow customers to magnify the main image on hover (desktop) or tap (mobile).',
    category: 'products', section: 'Gallery interaction' }),
  'products.galleryFullscreenEnabled':   entry({ key: 'products.galleryFullscreenEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Fullscreen viewer', description: 'Show the "View fullscreen" affordance on the main image. Opens a focus-trapped lightbox.',
    category: 'products', section: 'Gallery interaction' }),
  'products.galleryLoopEnabled':         entry({ key: 'products.galleryLoopEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Loop gallery navigation', description: 'When on, Next at the last image wraps to the first (and Prev at the first wraps to the last). Off by default for predictability.',
    category: 'products', section: 'Gallery interaction' }),
  'products.galleryTransitionMs':        entry({ key: 'products.galleryTransitionMs', type: 'number',
    default: 150, validation: num(150, { int: true, min: 0, max: 500 }),
    label: 'Transition duration (ms)', description: 'Fade duration when switching the main image. 0 disables the animation. `prefers-reduced-motion` always wins regardless of this value.',
    category: 'products', section: 'Gallery interaction' }),
  'products.galleryThumbnailPosition':   entry({ key: 'products.galleryThumbnailPosition', type: 'enum',
    default: 'bottom' as const,
    validation: enumOf(['bottom', 'left'] as const, 'bottom'),
    label: 'Thumbnail position', description: 'Where the thumbnail rail sits on desktop. Mobile always uses bottom regardless.',
    category: 'products', section: 'Gallery interaction',
    enumOptions: [
      { value: 'bottom', label: 'Below the main image' },
      { value: 'left',   label: 'To the left of the main image (desktop only)' },
    ] }),

  'features.reviewsEnabled':            entry({ key: 'features.reviewsEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Product reviews', description: 'Allow customers to write product reviews.',
    category: 'features', section: 'Customer experience' }),
  'features.reviewsRequirePurchase':    entry({ key: 'features.reviewsRequirePurchase', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Verified-purchase reviews only', description: 'Restrict reviews to customers who purchased the product.',
    category: 'features', section: 'Customer experience' }),
  'features.ratingsEnabled':            entry({ key: 'features.ratingsEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Star ratings', description: 'Show star ratings on product pages.',
    category: 'features', section: 'Customer experience' }),
  'features.b2bEnabled':                entry({ key: 'features.b2bEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'B2B portal', description: 'Enable the B2B portal (/b2b/*).',
    category: 'features', section: 'B2B' }),
  'features.b2bRegistrationEnabled':    entry({ key: 'features.b2bRegistrationEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'B2B applications', description: 'Allow new B2B applications.',
    category: 'features', section: 'B2B' }),
  'features.loyaltyEnabled':            entry({ key: 'features.loyaltyEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Loyalty program', description: 'Master switch for points + signup/referral bonuses.',
    category: 'features', section: 'Marketing',
    affectsJobs: [JOB_TYPES.ANALYTICS_DAILY_ROLLUP] }),
  'features.referralEnabled':           entry({ key: 'features.referralEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Referrals', description: 'Show the referral panel and award referral bonuses.',
    category: 'features', section: 'Marketing' }),
  'features.couponsEnabled':            entry({ key: 'features.couponsEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Coupons at checkout', description: 'Accept coupon redemption at checkout.',
    category: 'features', section: 'Marketing' }),
  'features.promotionsEnabled':         entry({ key: 'features.promotionsEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Promotions engine', description: 'Enable the promotions engine (Item 11). Default off until first use.',
    category: 'features', section: 'Marketing' }),
  'features.subscriptionsEnabled':      entry({ key: 'features.subscriptionsEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Back-in-stock subscriptions', description: 'Allow customers to subscribe to back-in-stock notifications.',
    category: 'features', section: 'Customer experience' }),
  'features.liveChat':                  entry({ key: 'features.liveChat', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Live chat', description: 'Enable in-store live chat.',
    category: 'features', section: 'Support' }),
  'features.supportTickets':            entry({ key: 'features.supportTickets', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Support tickets', description: 'Enable the support ticket system.',
    category: 'features', section: 'Support' }),
  'features.productShare':              entry({ key: 'features.productShare', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Product share button', description: 'Show the share button on product pages.',
    category: 'features', section: 'Customer experience' }),
  'features.quickView':                 entry({ key: 'features.quickView', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Quick view modal', description: 'Enable product quick-view modal (Item 23 — not yet implemented).',
    category: 'features', section: 'Customer experience' }),
  'features.recentlyViewed':            entry({ key: 'features.recentlyViewed', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Recently viewed', description: 'Show recently-viewed products carousel (Item 27 — not yet implemented).',
    category: 'features', section: 'Customer experience' }),
  'features.aiFeatures':                entry({ key: 'features.aiFeatures', type: 'boolean',
    default: false, validation: bool(false),
    label: 'AI features (master)', description: 'Master toggle for all AI-powered features (Item 37+).',
    category: 'features', section: 'AI', dangerLevel: 'caution' }),

  // ─── payments ───────────────────────────────────────────────────────────
  'payments.upiEnabled':              entry({ key: 'payments.upiEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Accept UPI', description: 'Allow UPI payments at checkout. Disabling prevents all new orders.',
    category: 'payments', section: 'Methods', dangerLevel: 'danger' }),
  'payments.upiId':                   entry({ key: 'payments.upiId', type: 'string',
    default: '', validation: str('', { max: 120 }),
    label: 'UPI ID (display override)', description: 'Display-only override for the UPI ID. Leave empty to use the value from PAYMENT_UPI_ID.',
    category: 'payments', section: 'Methods' }),
  'payments.displayName':             entry({ key: 'payments.displayName', type: 'string',
    default: '', validation: str('', { max: 120 }),
    label: 'Payment display name', description: 'Merchant name shown on the payment QR / receipt.',
    category: 'payments', section: 'Methods' }),
  'payments.qrImageUrl':              entry({ key: 'payments.qrImageUrl', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'QR image URL', description: 'Public URL to the payment QR PNG.',
    category: 'payments', section: 'Methods' }),
  'payments.manualVerification':      entry({ key: 'payments.manualVerification', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Require manual UTR verification', description: 'Admin must manually verify each UTR before order processing.',
    category: 'payments', section: 'Verification' }),
  'payments.autoVerificationEnabled': entry({ key: 'payments.autoVerificationEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Auto-verify payments', description: 'Future: auto-verify via PSP webhook. Currently unused.',
    category: 'payments', section: 'Verification' }),
  'payments.receiptRequired':         entry({ key: 'payments.receiptRequired', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Require receipt upload', description: 'Customer must upload a payment receipt at checkout.',
    category: 'payments', section: 'Verification' }),
  'payments.minOrderPaise':           entry({ key: 'payments.minOrderPaise', type: 'number',
    default: 0, validation: num(0, { int: true, min: 0 }),
    label: 'Minimum order (paise)', description: 'Reject orders below this subtotal (paise).',
    category: 'payments', section: 'Limits' }),
  'payments.maxOrderPaise':           entry({ key: 'payments.maxOrderPaise', type: 'number',
    default: 10_000_000, validation: num(10_000_000, { int: true, min: 0 }),
    label: 'Maximum order (paise)', description: 'Reject orders above this subtotal (paise). 10,000,000 paise = ₹1,00,000.',
    category: 'payments', section: 'Limits' }),

  // ─── shipping ───────────────────────────────────────────────────────────
  'shipping.freeShippingEnabled':         entry({ key: 'shipping.freeShippingEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Free shipping threshold', description: 'Waive shipping above the threshold below.',
    category: 'shipping', section: 'Pricing' }),
  'shipping.freeShippingThresholdPaise':  entry({ key: 'shipping.freeShippingThresholdPaise', type: 'number',
    default: 50_000, validation: num(50_000, { int: true, min: 0 }),
    label: 'Free-shipping threshold (paise)', description: 'Order subtotal above which shipping is free.',
    category: 'shipping', section: 'Pricing' }),
  'shipping.defaultShippingRatePaise':    entry({ key: 'shipping.defaultShippingRatePaise', type: 'number',
    default: 5_000, validation: num(5_000, { int: true, min: 0 }),
    label: 'Default shipping rate (paise)', description: 'Flat shipping charge applied below the free threshold.',
    category: 'shipping', section: 'Pricing' }),
  'shipping.serviceableStates':           entry({ key: 'shipping.serviceableStates', type: 'json',
    default: INDIAN_STATES as unknown as string[],
    validation: z.array(z.string().min(1).max(80)).default(INDIAN_STATES as unknown as string[]),
    label: 'Serviceable states', description: 'Indian states ShopCore will deliver to.',
    category: 'shipping', section: 'Coverage' }),
  'shipping.estimatedDeliveryDays':       entry({ key: 'shipping.estimatedDeliveryDays', type: 'number',
    default: 5, validation: num(5, { int: true, min: 1, max: 60 }),
    label: 'Estimated delivery (days)', description: 'Default delivery estimate shown at checkout.',
    category: 'shipping', section: 'Coverage' }),
  'shipping.expressDeliveryEnabled':      entry({ key: 'shipping.expressDeliveryEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Express delivery option', description: 'Offer express delivery at checkout (Item 10 carrier integration required).',
    category: 'shipping', section: 'Express' }),
  'shipping.expressDeliveryRatePaise':    entry({ key: 'shipping.expressDeliveryRatePaise', type: 'number',
    default: 15_000, validation: num(15_000, { int: true, min: 0 }),
    label: 'Express delivery rate (paise)', description: 'Flat express delivery charge.',
    category: 'shipping', section: 'Express' }),
  'shipping.shiprocketEnabled':           entry({ key: 'shipping.shiprocketEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Shiprocket integration', description: 'Enable Shiprocket carrier (Item 10 — not yet implemented).',
    category: 'shipping', section: 'Carriers' }),
  'shipping.delhiveryEnabled':            entry({ key: 'shipping.delhiveryEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Delhivery integration', description: 'Enable Delhivery carrier (Item 10 — not yet implemented).',
    category: 'shipping', section: 'Carriers' }),

  // ─── checkout ───────────────────────────────────────────────────────────
  'checkout.maxCartItems':                entry({ key: 'checkout.maxCartItems', type: 'number',
    default: 20, validation: num(20, { int: true, min: 1, max: 200 }),
    label: 'Max cart items', description: 'Maximum line items per cart.',
    category: 'checkout', section: 'Limits' }),
  'checkout.maxQuantityPerItem':          entry({ key: 'checkout.maxQuantityPerItem', type: 'number',
    default: 10, validation: num(10, { int: true, min: 1, max: 1000 }),
    label: 'Max qty per item', description: 'Maximum quantity per line item.',
    category: 'checkout', section: 'Limits' }),
  'checkout.cartExpiryHours':             entry({ key: 'checkout.cartExpiryHours', type: 'number',
    default: 72, validation: num(72, { int: true, min: 1, max: 720 }),
    label: 'Cart expiry (hours)', description: 'Hours of inactivity before a cart is considered abandoned.',
    category: 'checkout', section: 'Cart lifecycle' }),
  'checkout.abandonedCartReminderHours':  entry({ key: 'checkout.abandonedCartReminderHours', type: 'number',
    default: 2,  validation: num(2,  { int: true, min: 1, max: 72 }),
    label: 'Abandoned cart reminder delay (h)', description: 'Hours after last update before reminder email fires.',
    category: 'checkout', section: 'Cart lifecycle',
    affectsJobs: [JOB_TYPES.ABANDONED_CART_REMINDER] }),
  'checkout.idempotencyWindowMinutes':    entry({ key: 'checkout.idempotencyWindowMinutes', type: 'number',
    default: 10, validation: num(10, { int: true, min: 1, max: 1440 }),
    label: 'Idempotency window (min)', description: 'Validity window for idempotency keys.',
    category: 'checkout', section: 'Reliability' }),
  'checkout.taxRatePercent':              entry({ key: 'checkout.taxRatePercent', type: 'number',
    default: 18, validation: num(18, { min: 0, max: 100 }),
    label: 'Tax rate (%)', description: 'Default GST percentage applied at checkout.',
    category: 'checkout', section: 'Tax' }),
  'checkout.taxIncluded':                 entry({ key: 'checkout.taxIncluded', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Tax included in displayed price', description: 'When ON, displayed prices already include GST.',
    category: 'checkout', section: 'Tax' }),
  'checkout.termsUrl':                    entry({ key: 'checkout.termsUrl', type: 'string',
    default: '/terms', validation: str('/terms', { max: 200 }),
    label: 'Terms URL', description: 'Link to the terms and conditions page.',
    category: 'checkout', section: 'Legal' }),
  'checkout.privacyUrl':                  entry({ key: 'checkout.privacyUrl', type: 'string',
    default: '/privacy', validation: str('/privacy', { max: 200 }),
    label: 'Privacy URL', description: 'Link to the privacy policy page.',
    category: 'checkout', section: 'Legal' }),

  // ─── loyalty ────────────────────────────────────────────────────────────
  'loyalty.pointsPerRupeePaise':    entry({ key: 'loyalty.pointsPerRupeePaise', type: 'number',
    default: 1, validation: num(1, { int: true, min: 0, max: 10_000 }),
    label: 'Points per ₹1 spent', description: 'Loyalty points awarded per rupee of qualifying spend.',
    category: 'loyalty', section: 'Earning' }),
  'loyalty.pointsValuePaise':       entry({ key: 'loyalty.pointsValuePaise', type: 'number',
    default: 100, validation: num(100, { int: true, min: 1 }),
    label: '1 point value (paise)', description: 'Paise value of one loyalty point at redemption. 100 paise = ₹1.',
    category: 'loyalty', section: 'Redemption' }),
  'loyalty.minRedemptionPoints':    entry({ key: 'loyalty.minRedemptionPoints', type: 'number',
    default: 100, validation: num(100, { int: true, min: 0 }),
    label: 'Min redeemable points', description: 'Smallest number of points the customer may redeem in one order.',
    category: 'loyalty', section: 'Redemption' }),
  'loyalty.maxRedemptionPercent':   entry({ key: 'loyalty.maxRedemptionPercent', type: 'number',
    default: 10, validation: num(10, { min: 0, max: 100 }),
    label: 'Max % of order via points', description: 'Maximum share of an order payable using points.',
    category: 'loyalty', section: 'Redemption' }),
  'loyalty.pointsExpiryDays':       entry({ key: 'loyalty.pointsExpiryDays', type: 'number',
    default: 365, validation: num(365, { int: true, min: 0 }),
    label: 'Points expiry (days)', description: 'Days until unused points expire. 0 means never expire.',
    category: 'loyalty', section: 'Earning' }),
  'loyalty.referralBonusPoints':    entry({ key: 'loyalty.referralBonusPoints', type: 'number',
    default: 100, validation: num(100, { int: true, min: 0 }),
    label: 'Referral bonus points', description: 'Points awarded for a successful referral.',
    category: 'loyalty', section: 'Bonuses' }),
  'loyalty.signupBonusPoints':      entry({ key: 'loyalty.signupBonusPoints', type: 'number',
    default: 50, validation: num(50, { int: true, min: 0 }),
    label: 'Signup bonus points', description: 'Points awarded when a new account is activated.',
    category: 'loyalty', section: 'Bonuses' }),

  // ─── b2b ────────────────────────────────────────────────────────────────
  'b2b.minOrderValuePaise':   entry({ key: 'b2b.minOrderValuePaise', type: 'number',
    default: 500_000, validation: num(500_000, { int: true, min: 0 }),
    label: 'B2B min order value (paise)', description: 'Minimum order value for B2B accounts. 500,000 paise = ₹5,000.',
    category: 'b2b', section: 'Ordering' }),
  'b2b.quoteExpiryDays':      entry({ key: 'b2b.quoteExpiryDays', type: 'number',
    default: 7, validation: num(7, { int: true, min: 1, max: 90 }),
    label: 'Quote validity (days)', description: 'Days before a B2B quote auto-expires.',
    category: 'b2b', section: 'Quotes',
    affectsJobs: [JOB_TYPES.B2B_QUOTE_EXPIRY] }),
  'b2b.autoApprovalEnabled':  entry({ key: 'b2b.autoApprovalEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Auto-approve B2B applications', description: 'Auto-approve B2B applications instead of requiring admin review.',
    category: 'b2b', section: 'Applications', dangerLevel: 'caution' }),
  'b2b.requireGstin':         entry({ key: 'b2b.requireGstin', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Require GSTIN', description: 'Require a valid GSTIN on B2B applications.',
    category: 'b2b', section: 'Applications' }),
  'b2b.creditTermsDays':      entry({ key: 'b2b.creditTermsDays', type: 'number',
    default: 0, validation: num(0, { int: true, min: 0, max: 180 }),
    label: 'Default credit terms (days)', description: 'Net-N payment terms offered to B2B customers. 0 disables credit.',
    category: 'b2b', section: 'Ordering' }),

  // ─── notifications ──────────────────────────────────────────────────────
  'notifications.emailEnabled':         entry({ key: 'notifications.emailEnabled', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Transactional emails (master)', description: 'Master switch for all transactional emails. Turning OFF stops every outgoing email.',
    category: 'notifications', section: 'Channels', dangerLevel: 'danger' }),
  'notifications.orderConfirmation':    entry({ key: 'notifications.orderConfirmation', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Order-confirmation emails', description: 'Send a confirmation email on every successful order.',
    category: 'notifications', section: 'Order lifecycle' }),
  'notifications.orderStatusUpdate':    entry({ key: 'notifications.orderStatusUpdate', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Order-status update emails', description: 'Email customers on every status transition.',
    category: 'notifications', section: 'Order lifecycle' }),
  'notifications.abandonedCartEmail':   entry({ key: 'notifications.abandonedCartEmail', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Abandoned-cart reminders', description: 'Send reminder emails for stale carts.',
    category: 'notifications', section: 'Marketing',
    affectsJobs: [JOB_TYPES.ABANDONED_CART_REMINDER] }),
  'notifications.lowStockAlertEmail':   entry({ key: 'notifications.lowStockAlertEmail', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Low-stock alerts', description: 'Email admins when product stock falls to or below the threshold.',
    category: 'notifications', section: 'Inventory',
    affectsJobs: [JOB_TYPES.LOW_STOCK_ALERT] }),
  'notifications.reviewRequestEmail':   entry({ key: 'notifications.reviewRequestEmail', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Review request emails', description: 'Ask customers for a review N days after delivery.',
    category: 'notifications', section: 'Marketing' }),
  'notifications.welcomeEmail':         entry({ key: 'notifications.welcomeEmail', type: 'boolean',
    default: true,  validation: bool(true),
    label: 'Welcome emails', description: 'Send a welcome email on account activation.',
    category: 'notifications', section: 'Account lifecycle' }),
  'notifications.adminEmail':           entry({ key: 'notifications.adminEmail', type: 'string',
    default: '', validation: z.string().refine((s) => s === '' || z.string().email().safeParse(s).success,
      { message: 'Must be a valid email or empty.' }).default(''),
    label: 'Admin notification recipient', description: 'Email that receives admin notifications (low-stock, etc.). Empty falls back to the first ACTIVE admin user.',
    category: 'notifications', section: 'Channels' }),
  'notifications.lowStockThreshold':    entry({ key: 'notifications.lowStockThreshold', type: 'number',
    default: 5, validation: num(5, { int: true, min: 0, max: 10_000 }),
    label: 'Low-stock threshold', description: 'Stock level at or below which the low-stock alert fires.',
    category: 'notifications', section: 'Inventory',
    affectsJobs: [JOB_TYPES.LOW_STOCK_ALERT] }),

  // ─── security ───────────────────────────────────────────────────────────
  'security.maxLoginAttempts':      entry({ key: 'security.maxLoginAttempts', type: 'number',
    default: 5, validation: num(5, { int: true, min: 1, max: 100 }),
    label: 'Max login attempts', description: 'Failed-login attempts before an account is locked out.',
    category: 'security', section: 'Authentication', dangerLevel: 'caution' }),
  'security.sessionTimeoutMinutes': entry({ key: 'security.sessionTimeoutMinutes', type: 'number',
    default: 15, validation: num(15, { int: true, min: 5, max: 1440 }),
    label: 'Session timeout (min)', description: 'JWT access-token lifetime. Long values reduce login friction; short values reduce stolen-token blast radius.',
    category: 'security', section: 'Authentication', requiresRestart: true, dangerLevel: 'caution' }),
  'security.requireStrongPassword': entry({ key: 'security.requireStrongPassword', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Strong password policy', description: 'Enforce the strong-password validator on signup + change password.',
    category: 'security', section: 'Authentication', dangerLevel: 'danger' }),
  'security.allowedImageDomains':   entry({ key: 'security.allowedImageDomains', type: 'json',
    default: [] as string[], validation: z.array(z.string().min(1).max(200)).default([]),
    label: 'Allowed external image domains', description: 'Hostnames allowed in <img src> beyond local uploads.',
    category: 'security', section: 'Content' }),
  'security.ipWhitelist':           entry({ key: 'security.ipWhitelist', type: 'json',
    default: [] as string[],
    validation: z.array(ipString).default([]),
    label: 'Admin IP whitelist', description: 'Restrict admin-panel access to these IPs / CIDRs. Empty list means no restriction.',
    category: 'security', section: 'Access control', dangerLevel: 'danger' }),

  // ─── performance ────────────────────────────────────────────────────────
  'performance.productCacheTtlSeconds':    entry({ key: 'performance.productCacheTtlSeconds', type: 'number',
    default: 300, validation: num(300, { int: true, min: 0, max: 86_400 }),
    label: 'Product list cache TTL (s)', description: 'In-process cache TTL for the public product list.',
    category: 'performance', section: 'Caching' }),
  'performance.heroBannerCacheTtlSeconds': entry({ key: 'performance.heroBannerCacheTtlSeconds', type: 'number',
    default: 60, validation: num(60, { int: true, min: 0, max: 3_600 }),
    label: 'Hero banner cache TTL (s)', description: 'In-process cache TTL for the homepage hero banners.',
    category: 'performance', section: 'Caching' }),
  'performance.paginationDefaultSize':     entry({ key: 'performance.paginationDefaultSize', type: 'number',
    default: 20, validation: num(20, { int: true, min: 5, max: 200 }),
    label: 'Default page size', description: 'Default page size for paginated lists.',
    category: 'performance', section: 'Pagination' }),
  'performance.paginationMaxSize':         entry({ key: 'performance.paginationMaxSize', type: 'number',
    default: 100, validation: num(100, { int: true, min: 10, max: 1000 }),
    label: 'Max page size', description: 'Hard cap on pageSize the API accepts.',
    category: 'performance', section: 'Pagination' }),
  'performance.imageOptimizationEnabled':  entry({ key: 'performance.imageOptimizationEnabled', type: 'boolean',
    default: true, validation: bool(true),
    label: 'Image optimisation', description: 'Re-encode admin uploads through sharp. Disable only when troubleshooting.',
    category: 'performance', section: 'Images' }),

  // Item 12 Phase 2 — pagination SEO & UX knobs.
  'performance.paginationNoindexFromPage': entry({ key: 'performance.paginationNoindexFromPage', type: 'number',
    default: 2, validation: num(2, { int: true, min: 1, max: 100 }),
    label: 'Pagination noindex from page', description: 'Pages with `?page >= N` on `/c/[slug]` and `/search` carry `<meta name="robots" content="noindex,follow">`. Set 1 to noindex EVERY paginated page; set 100 to effectively disable.',
    category: 'performance', section: 'Pagination' }),
  'performance.paginationJumpInputThreshold': entry({ key: 'performance.paginationJumpInputThreshold', type: 'number',
    default: 10, validation: num(10, { int: true, min: 2, max: 1000 }),
    label: 'Jump-to-page input threshold', description: 'Show the "Go to page …" input on the pagination control once `totalPages >= N`. Lower numbers expose the input more often.',
    category: 'performance', section: 'Pagination' }),
  'performance.paginationInfiniteScrollEnabled': entry({ key: 'performance.paginationInfiniteScrollEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Infinite scroll (storefront)', description: 'Storefront PLP and wishlist pages auto-load the next page as the user scrolls. The numbered <Pagination> bar still renders as a no-JS / SEO fallback.',
    category: 'performance', section: 'Pagination' }),

  // ─── maintenance ────────────────────────────────────────────────────────
  'maintenance.maintenanceMode':         entry({ key: 'maintenance.maintenanceMode', type: 'boolean',
    default: false, validation: bool(false),
    label: '⚠ Maintenance mode', description: 'Redirect every non-admin customer to /maintenance. Admin panel and auth endpoints continue to work.',
    category: 'maintenance', section: 'Maintenance window', dangerLevel: 'danger' }),
  'maintenance.maintenanceMessage':      entry({ key: 'maintenance.maintenanceMessage', type: 'string',
    default: 'We are performing scheduled maintenance and will be back shortly.',
    validation: str('We are performing scheduled maintenance and will be back shortly.', { max: 500 }),
    label: 'Maintenance message', description: 'Message shown on the /maintenance page.',
    category: 'maintenance', section: 'Maintenance window' }),
  'maintenance.maintenanceEstimatedEnd': entry({ key: 'maintenance.maintenanceEstimatedEnd', type: 'string',
    default: '', validation: z.string().refine(
      (s) => s === '' || !Number.isNaN(Date.parse(s)),
      { message: 'Must be an ISO datetime string, or empty.' }).default(''),
    label: 'Estimated end (ISO)', description: 'Estimated end-of-maintenance time (ISO 8601). Leave empty for "we will be back soon".',
    category: 'maintenance', section: 'Maintenance window' }),
  'maintenance.allowedMaintenanceIps':   entry({ key: 'maintenance.allowedMaintenanceIps', type: 'json',
    default: [] as string[], validation: z.array(ipString).default([]),
    label: 'Allowed maintenance IPs', description: 'IPs that bypass maintenance mode (for testing the storefront).',
    category: 'maintenance', section: 'Maintenance window' }),
  'maintenance.bannerEnabled':           entry({ key: 'maintenance.bannerEnabled', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Announcement banner', description: 'Show a sitewide announcement banner.',
    category: 'maintenance', section: 'Announcement banner' }),
  'maintenance.bannerMessage':           entry({ key: 'maintenance.bannerMessage', type: 'string',
    default: '', validation: str('', { max: 500 }),
    label: 'Banner message', description: 'Text shown in the announcement banner.',
    category: 'maintenance', section: 'Announcement banner' }),
  'maintenance.bannerType':              entry({ key: 'maintenance.bannerType', type: 'enum',
    default: 'info' as const,
    validation: enumOf(['info', 'warning', 'error', 'success'] as const, 'info'),
    label: 'Banner type', description: 'Visual style of the announcement banner.',
    category: 'maintenance', section: 'Announcement banner',
    enumOptions: [
      { value: 'info',    label: 'Info (blue)' },
      { value: 'warning', label: 'Warning (amber)' },
      { value: 'error',   label: 'Error (red)' },
      { value: 'success', label: 'Success (green)' },
    ] }),
  'maintenance.bannerExpiresAt':         entry({ key: 'maintenance.bannerExpiresAt', type: 'string',
    default: '', validation: z.string().refine(
      (s) => s === '' || !Number.isNaN(Date.parse(s)),
      { message: 'Must be an ISO datetime string, or empty.' }).default(''),
    label: 'Banner expires at (ISO)', description: 'ISO datetime when the banner auto-hides. Past values hide the banner immediately.',
    category: 'maintenance', section: 'Announcement banner' }),
  'maintenance.registrationPaused':      entry({ key: 'maintenance.registrationPaused', type: 'boolean',
    default: false, validation: bool(false),
    label: 'Pause new registrations', description: 'Temporarily reject new signups without disabling the feature permanently.',
    category: 'maintenance', section: 'Pause switches', dangerLevel: 'caution' }),
  'maintenance.checkoutPaused':          entry({ key: 'maintenance.checkoutPaused', type: 'boolean',
    default: false, validation: bool(false),
    label: '⚠ Pause checkout', description: 'Temporarily reject all checkout attempts. Customers can still browse, log in, and view orders.',
    category: 'maintenance', section: 'Pause switches', dangerLevel: 'danger' }),
} as const;

/** Compile-time guarantee that the `validation` zod schema for every
 *  entry produces a value of the same type as `default`. */
type _Check = { [K in keyof typeof CONFIG_SCHEMA]:
  (typeof CONFIG_SCHEMA)[K] extends ConfigEntry<infer T>
    ? (typeof CONFIG_SCHEMA)[K]['default'] extends T ? true : never
    : never };
// Reference _Check once so TS doesn't tree-shake the type-only check away.
export type _CheckExported = _Check;

export type ConfigKey = keyof typeof CONFIG_SCHEMA;

export const ALL_CONFIG_KEYS: readonly ConfigKey[] =
  Object.keys(CONFIG_SCHEMA) as ConfigKey[];

export function isConfigKey(s: string): s is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, s);
}

// Re-export the Zod type for callers that need raw access.
export type { ZodTypeAny };
