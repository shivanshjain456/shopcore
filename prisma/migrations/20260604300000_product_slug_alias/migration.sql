-- Feature #35 — Product shareable URLs: alias table so old slugs keep resolving.
CREATE TABLE "ProductSlugAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductSlugAlias_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductSlugAlias_slug_key"  ON "ProductSlugAlias"("slug");
CREATE INDEX        "ProductSlugAlias_productId_idx" ON "ProductSlugAlias"("productId");
