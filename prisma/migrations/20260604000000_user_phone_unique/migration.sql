-- Feature #11 — phone uniqueness. The seed data has already been deduped
-- before this migration runs (test fixtures get a `_dupN` suffix). Going
-- forward, every new registration writes a guaranteed-unique phone or
-- trips Prisma's P2002 → our server-side validator catches it and returns
-- HTTP 409 with "An account with this phone number already exists."
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
