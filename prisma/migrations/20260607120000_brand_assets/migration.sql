-- Brand & Category asset overhaul — Item 17. See BUILD_LOG.md.
--
-- Adds:
--   1. Brand.bannerUrl                 — optional wider banner for brand pages
--   2. Category.bannerUrl              — wide banner above the category listing
--      Category.iconUrl                — small icon for nav dropdowns
--   3. StoreAsset table                — generic registry of every uploaded asset
--                                        (kind, dimensions, bytes, uploaded-by).
--                                        Powers the asset health dashboard
--                                        (Phase 2) and the asset browser.
--
-- Existing columns NOT re-added (already present in schema):
--   Brand.logoUrl, Brand.description, Category.imageUrl, Category.description

ALTER TABLE "Brand"    ADD COLUMN "bannerUrl" TEXT;
ALTER TABLE "Category" ADD COLUMN "bannerUrl" TEXT;
ALTER TABLE "Category" ADD COLUMN "iconUrl"   TEXT;

CREATE TABLE "StoreAsset" (
  "id"         TEXT     NOT NULL PRIMARY KEY,
  "kind"       TEXT     NOT NULL,
  "url"        TEXT     NOT NULL,
  "altText"    TEXT,
  "width"      INTEGER,
  "height"     INTEGER,
  "mimeType"   TEXT,
  "bytes"      INTEGER,
  "uploadedBy" TEXT     NOT NULL,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreAsset_uploadedBy_fkey"
    FOREIGN KEY ("uploadedBy") REFERENCES "User" ("id")
);

CREATE UNIQUE INDEX "StoreAsset_url_key"            ON "StoreAsset" ("url");
CREATE        INDEX "StoreAsset_kind_createdAt_idx" ON "StoreAsset" ("kind", "createdAt");
CREATE        INDEX "StoreAsset_uploadedBy_idx"     ON "StoreAsset" ("uploadedBy");
