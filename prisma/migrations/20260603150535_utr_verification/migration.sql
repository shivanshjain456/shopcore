-- CreateTable
CREATE TABLE "UtrSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "utrNormalized" TEXT NOT NULL,
    "utrSubmitted" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "orderId" TEXT,
    "userId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "rejectReason" TEXT,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "verifiedAt" DATETIME,
    "verifiedBy" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT_REVIEW',
    "subtotalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL DEFAULT 0,
    "shippingPaise" INTEGER NOT NULL DEFAULT 0,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "totalPaise" INTEGER NOT NULL,
    "couponId" TEXT,
    "shippingAddressId" TEXT,
    "billingAddressId" TEXT,
    "addressSnapshot" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'AWAITING_VERIFICATION',
    "paymentMethod" TEXT NOT NULL DEFAULT 'UPI',
    "utrNumber" TEXT,
    "receiptUrl" TEXT,
    "paymentVerifiedAt" DATETIME,
    "paymentVerifiedBy" TEXT,
    "paymentRejectReason" TEXT,
    "amountVerifiedAt" DATETIME,
    "courierName" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "shippedAt" DATETIME,
    "deliveredAt" DATETIME,
    "customerNote" TEXT,
    "internalNote" TEXT,
    "isB2B" BOOLEAN NOT NULL DEFAULT false,
    "gstinAtOrder" TEXT,
    "loyaltyFormulaSnapshot" TEXT,
    "loyaltyPointsEarned" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "Address" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_billingAddressId_fkey" FOREIGN KEY ("billingAddressId") REFERENCES "Address" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("addressSnapshot", "billingAddressId", "couponId", "courierName", "createdAt", "customerNote", "deliveredAt", "discountPaise", "gstinAtOrder", "id", "internalNote", "isB2B", "loyaltyFormulaSnapshot", "loyaltyPointsEarned", "orderNumber", "paymentRejectReason", "paymentStatus", "paymentVerifiedAt", "paymentVerifiedBy", "receiptUrl", "shippedAt", "shippingAddressId", "shippingPaise", "status", "subtotalPaise", "taxPaise", "totalPaise", "trackingNumber", "trackingUrl", "updatedAt", "userId", "utrNumber") SELECT "addressSnapshot", "billingAddressId", "couponId", "courierName", "createdAt", "customerNote", "deliveredAt", "discountPaise", "gstinAtOrder", "id", "internalNote", "isB2B", "loyaltyFormulaSnapshot", "loyaltyPointsEarned", "orderNumber", "paymentRejectReason", "paymentStatus", "paymentVerifiedAt", "paymentVerifiedBy", "receiptUrl", "shippedAt", "shippingAddressId", "shippingPaise", "status", "subtotalPaise", "taxPaise", "totalPaise", "trackingNumber", "trackingUrl", "updatedAt", "userId", "utrNumber" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX "Order_status_idx" ON "Order"("status");
CREATE INDEX "Order_orderNumber_idx" ON "Order"("orderNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UtrSubmission_orderId_idx" ON "UtrSubmission"("orderId");

-- CreateIndex
CREATE INDEX "UtrSubmission_userId_idx" ON "UtrSubmission"("userId");

-- CreateIndex
CREATE INDEX "UtrSubmission_createdAt_idx" ON "UtrSubmission"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UtrSubmission_utrNormalized_key" ON "UtrSubmission"("utrNormalized");
