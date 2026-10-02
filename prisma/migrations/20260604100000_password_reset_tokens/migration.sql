-- Feature #12 — Forgot/Reset Password (OTP-based, two-stage)

-- Add resetRequestId to OtpCode to bind a verify event to a reset request.
ALTER TABLE "OtpCode" ADD COLUMN "resetRequestId" TEXT;
CREATE INDEX "OtpCode_resetRequestId_idx" ON "OtpCode"("resetRequestId");

-- PasswordResetRequest
CREATE TABLE "PasswordResetRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "otpIssueCount" INTEGER NOT NULL DEFAULT 1,
    "maxOtpIssue" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PasswordResetRequest_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PasswordResetRequest_email_idx"     ON "PasswordResetRequest"("email");
CREATE INDEX "PasswordResetRequest_userId_idx"    ON "PasswordResetRequest"("userId");
CREATE INDEX "PasswordResetRequest_status_idx"    ON "PasswordResetRequest"("status");
CREATE INDEX "PasswordResetRequest_expiresAt_idx" ON "PasswordResetRequest"("expiresAt");

-- PasswordResetToken
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "PasswordResetRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_requestId_idx" ON "PasswordResetToken"("requestId");
CREATE INDEX "PasswordResetToken_userId_idx"    ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
