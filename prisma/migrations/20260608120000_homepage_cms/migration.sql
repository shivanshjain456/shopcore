-- Homepage CMS — Item 18 Phase 1. See BUILD_LOG.md.
--
-- Three tables:
--   1. HomepageSection — the ordered list of sections that compose
--      the storefront homepage. `kind` discriminates the renderer
--      (HERO, FEATURED_BRANDS, TOP_CATEGORIES, PRODUCT_COLLECTION,
--      WIDE_PROMO_BANNER, DUAL_PROMO_CARDS, BRAND_SHOWCASE,
--      STORE_METRICS, WHY_SHOP_WITH_US, BRANCHES, NEWSLETTER,
--      MOST_RATED_PRODUCTS, TRENDING_PRODUCTS). `config` is a JSON
--      blob whose shape is validated per-kind by Zod in
--      `lib/cms/homepageSchemas.ts`. Scheduling via startsAt/endsAt.
--   2. HomepageMetric — admin-editable trust-metric tiles (orders
--      served, customers served, brands available, years in business)
--      surfaced by the STORE_METRICS section.
--   3. HomepageBranch — physical store locations surfaced by the
--      BRANCHES section.
--
-- All three are seeded on first boot (lib/cms/homepageDefaults.ts) so
-- a fresh install renders a sensible homepage immediately.

CREATE TABLE "HomepageSection" (
  "id"           TEXT     NOT NULL PRIMARY KEY,
  -- Section discriminator. Source of truth for valid values lives in
  -- src/lib/cms/homepageSchemas.ts (HOMEPAGE_SECTION_KINDS).
  "kind"         TEXT     NOT NULL,
  -- Stable handle for admin / log lines, e.g. "summer-deals", "best-sellers".
  -- @unique so admins can edit without ID-guessing.
  "slug"         TEXT     NOT NULL,
  -- Optional admin-only label shown in the editor.
  "title"        TEXT,
  -- Lower = renders first. Re-numbered on every reorder.
  "displayOrder" INTEGER  NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN  NOT NULL DEFAULT 1,
  -- Schedule window. Both NULL = always visible.
  "startsAt"     DATETIME,
  "endsAt"       DATETIME,
  -- JSON config — shape depends on `kind`. Empty `{}` is valid for
  -- sections that have nothing to configure (e.g. NEWSLETTER might
  -- read everything from the section row itself).
  "config"       TEXT     NOT NULL DEFAULT '{}',
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL
);
CREATE UNIQUE INDEX "HomepageSection_slug_key" ON "HomepageSection" ("slug");
-- Hot query: list active, in-window sections in display order.
CREATE        INDEX "HomepageSection_active_order_idx" ON "HomepageSection" ("isActive", "displayOrder");
-- Schedule query: find sections whose window matters now.
CREATE        INDEX "HomepageSection_window_idx" ON "HomepageSection" ("startsAt", "endsAt");

CREATE TABLE "HomepageMetric" (
  "id"           TEXT     NOT NULL PRIMARY KEY,
  -- Display label, e.g. "Orders served", "Customers served".
  "label"        TEXT     NOT NULL,
  -- The big number / string, e.g. "170+", "10M+", "1000+".
  "value"        TEXT     NOT NULL,
  -- Optional smaller line under the value, e.g. "Across India".
  "caption"      TEXT,
  -- Optional URL to an icon asset (uploaded via the existing
  -- /api/admin/uploads pipeline using kind "misc").
  "iconUrl"      TEXT,
  "displayOrder" INTEGER  NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN  NOT NULL DEFAULT 1,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL
);
CREATE INDEX "HomepageMetric_active_order_idx" ON "HomepageMetric" ("isActive", "displayOrder");

CREATE TABLE "HomepageBranch" (
  "id"           TEXT     NOT NULL PRIMARY KEY,
  "name"         TEXT     NOT NULL,
  -- City / area for the second line.
  "city"         TEXT     NOT NULL,
  -- Full address — shown on the detail link target if any.
  "address"      TEXT,
  -- Optional phone (E.164; normalised by lib/utils/phone).
  "phone"        TEXT,
  -- Optional photo URL (admin uploads via kind "misc").
  "imageUrl"     TEXT,
  -- Optional href — typically a Google Maps URL or an internal store page.
  "linkUrl"      TEXT,
  "displayOrder" INTEGER  NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN  NOT NULL DEFAULT 1,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL
);
CREATE INDEX "HomepageBranch_active_order_idx" ON "HomepageBranch" ("isActive", "displayOrder");
