-- Phone Verification feature — add Firebase-backed phone-OTP columns.
--
-- Behaviour:
--   - All NEW signups will land in PENDING_PHONE_VERIFICATION after email
--     OTP and only reach ACTIVE after a Firebase phone-OTP succeeds.
--   - Existing ACTIVE users are NOT retroactively moved; `phoneVerified`
--     defaults to FALSE and a soft prompt appears in the dashboard.
--
-- SQLite quirks:
--   - `ALTER TABLE ADD COLUMN` cannot inline a UNIQUE constraint; we add
--     `firebasePhoneUid` as a plain column, then enforce uniqueness via a
--     partial CREATE UNIQUE INDEX (`WHERE ... IS NOT NULL`) so the column
--     may legitimately be NULL on every row that has not yet verified.
--   - DEFAULT FALSE is portable; SQLite stores it as integer 0.
--
-- Rollback: SQLite cannot DROP COLUMN cleanly without a table rebuild.
-- Restore from `npm run db:backup` snapshot taken immediately before this
-- migration runs (the standard rollback path for SQLite + Prisma).

ALTER TABLE "User" ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "firebasePhoneUid" TEXT;

CREATE UNIQUE INDEX "User_firebasePhoneUid_key"
  ON "User"("firebasePhoneUid")
  WHERE "firebasePhoneUid" IS NOT NULL;
