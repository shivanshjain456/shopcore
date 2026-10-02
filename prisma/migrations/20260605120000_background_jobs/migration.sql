-- Background Jobs System — Item 7. See BUILD_LOG.md.
--
-- Tables:
--   Job          — the work queue (PENDING → PROCESSING → COMPLETED/FAILED/CANCELLED)
--   JobSchedule  — cron-driven recurring enqueues
--
-- Indexes are tuned for the runner's two hot queries:
--   (a) pick eligible job:  WHERE status='PENDING' AND runAt<=? ORDER BY priority DESC, runAt ASC
--   (b) reclaim stuck job:  WHERE status='PROCESSING' AND lockExpiresAt<?

CREATE TABLE "Job" (
  "id"             TEXT     NOT NULL PRIMARY KEY,
  "type"           TEXT     NOT NULL,
  "status"         TEXT     NOT NULL DEFAULT 'PENDING',
  "payload"        TEXT     NOT NULL DEFAULT '{}',
  "result"         TEXT,
  "error"          TEXT,
  "priority"       INTEGER  NOT NULL DEFAULT 0,
  "attempts"       INTEGER  NOT NULL DEFAULT 0,
  "maxAttempts"    INTEGER  NOT NULL DEFAULT 3,
  "runAt"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"      DATETIME,
  "completedAt"    DATETIME,
  "failedAt"       DATETIME,
  "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      DATETIME NOT NULL,
  "queueName"      TEXT     NOT NULL DEFAULT 'default',
  "parentJobId"    TEXT,
  "lockToken"      TEXT,
  "lockExpiresAt"  DATETIME
);

CREATE INDEX "Job_status_runAt_priority_idx"     ON "Job"("status", "runAt", "priority");
CREATE INDEX "Job_type_status_idx"               ON "Job"("type", "status");
CREATE INDEX "Job_queueName_status_runAt_idx"    ON "Job"("queueName", "status", "runAt");
CREATE INDEX "Job_parentJobId_idx"               ON "Job"("parentJobId");

CREATE TABLE "JobSchedule" (
  "id"             TEXT     NOT NULL PRIMARY KEY,
  "name"           TEXT     NOT NULL,
  "jobType"        TEXT     NOT NULL,
  "payload"        TEXT     NOT NULL DEFAULT '{}',
  "cronExpression" TEXT     NOT NULL,
  "queueName"      TEXT     NOT NULL DEFAULT 'default',
  "isActive"       BOOLEAN  NOT NULL DEFAULT true,
  "lastRunAt"      DATETIME,
  "nextRunAt"      DATETIME NOT NULL,
  "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      DATETIME NOT NULL
);

CREATE UNIQUE INDEX "JobSchedule_name_key"          ON "JobSchedule"("name");
CREATE INDEX "JobSchedule_isActive_nextRunAt_idx"   ON "JobSchedule"("isActive", "nextRunAt");

-- Add User.emailSubscribed (spec §3.8) — required by ABANDONED_CART_REMINDER
-- worker so we never send promotional mail to users who opted out.
-- Default TRUE matches existing-user expectation (status quo: receive mail).
ALTER TABLE "User" ADD COLUMN "emailSubscribed" BOOLEAN NOT NULL DEFAULT true;

