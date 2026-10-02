-- Product Gallery — Item 19. See BUILD_LOG.md.
--
-- Extends the existing ProductImage model with three columns that turn
-- it into a first-class gallery row:
--
--   isActive  BOOLEAN  default 1 — soft-disable without deleting the file.
--   createdAt DATETIME — audit trail.
--   updatedAt DATETIME — bumped via Prisma @updatedAt on every write.
--
-- A new compound index `(productId, isActive, sortOrder)` covers the
-- PDP-gallery read path AND every card/wishlist/search query that
-- pulls the first active image.
--
-- SQLite quirk: `ALTER TABLE … ADD COLUMN` only accepts CONSTANT
-- defaults — `CURRENT_TIMESTAMP` is rejected as "non-constant". We
-- therefore add the timestamp columns with a fixed epoch default
-- (1970-01-01 00:00:00) which lets the ALTER succeed, then immediately
-- UPDATE every existing row to NOW() so legacy product photography
-- doesn't appear to be from the Unix epoch. Going forward, the Prisma
-- runtime sets `createdAt` via `@default(now())` and `updatedAt` via
-- `@updatedAt` on every INSERT/UPDATE — no further DDL needed.
ALTER TABLE "ProductImage" ADD COLUMN "isActive"  BOOLEAN  NOT NULL DEFAULT 1;
ALTER TABLE "ProductImage" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00';
ALTER TABLE "ProductImage" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00';

UPDATE "ProductImage"
   SET "createdAt" = CURRENT_TIMESTAMP,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "createdAt" = '1970-01-01 00:00:00';

CREATE INDEX "ProductImage_productId_isActive_sortOrder_idx"
  ON "ProductImage"("productId", "isActive", "sortOrder");
