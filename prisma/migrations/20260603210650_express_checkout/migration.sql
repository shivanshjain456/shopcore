-- CreateTable
CREATE TABLE "ExpressCheckout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "consumedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExpressCheckout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExpressCheckout_expiresAt_idx" ON "ExpressCheckout"("expiresAt");

-- CreateIndex
CREATE INDEX "ExpressCheckout_consumedAt_idx" ON "ExpressCheckout"("consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExpressCheckout_userId_key" ON "ExpressCheckout"("userId");
