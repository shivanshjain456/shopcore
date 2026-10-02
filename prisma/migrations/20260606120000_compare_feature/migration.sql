-- Compare Feature overhaul — Item 14. See BUILD_LOG.md.
--
-- Two schema changes:
--   1. Product.attributes  TEXT NULL        ─ JSON map of free-form spec keys
--                                              (e.g. {"processor":"Ryzen 5 2600","ram":"16GB"})
--                                              consumed by /compare to build
--                                              spec rows. Nullable so existing
--                                              rows aren't disturbed; the
--                                              compare view shows "—" when
--                                              missing.
--   2. CompareItem         TABLE            ─ server-side compare list for
--                                              authenticated users (one row per
--                                              (userId, productId) pair).
--                                              Anonymous users keep using the
--                                              `sc_compare_v1` cookie until
--                                              login, when their local list is
--                                              merged into the DB via
--                                              POST /api/compare/sync.

ALTER TABLE "Product" ADD COLUMN "attributes" TEXT;

CREATE TABLE "CompareItem" (
  "id"        TEXT     NOT NULL PRIMARY KEY,
  "userId"    TEXT     NOT NULL,
  "productId" TEXT     NOT NULL,
  "addedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompareItem_userId_fkey"
    FOREIGN KEY ("userId")    REFERENCES "User"    ("id") ON DELETE CASCADE,
  CONSTRAINT "CompareItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product" ("id")
);

-- One row per (user, product) pair — same product can't be added twice.
CREATE UNIQUE INDEX "CompareItem_userId_productId_key" ON "CompareItem" ("userId", "productId");
-- Hot query: list a user's compare in recent-first order.
CREATE        INDEX "CompareItem_userId_addedAt_idx"   ON "CompareItem" ("userId", "addedAt");
