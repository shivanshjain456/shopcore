/**
 * Maintenance workers — DB_VACUUM, DB_BACKUP, AUDIT_LOG_ARCHIVE. Spec §2.7.
 *
 * DB_VACUUM and DB_BACKUP both hold SQLite locks for extended periods, so
 * they call `ctx.extendLock()` before starting (spec §3.7).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ValidationError, InternalError } from '@/lib/errors';
import type { JobContext, JobHandler } from '@/lib/jobs/workers';
import type {
  DbVacuumPayload, DbBackupPayload, AuditLogArchivePayload,
} from '@/lib/jobs/jobTypes';

// ─── DB_VACUUM ─────────────────────────────────────────────────────────────

const VacuumPayloadSchema = z.object({}).passthrough();
const ONE_HOUR_MS = 60 * 60 * 1000;

export const dbVacuumHandler: JobHandler<DbVacuumPayload> = async (payload, ctx: JobContext) => {
  const parsed = VacuumPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Invalid DB_VACUUM payload', { code: 'INVALID_JOB_PAYLOAD' });
  }
  // Extend the lock — VACUUM on a busy DB can take minutes.
  await ctx.extendLock(ONE_HOUR_MS);

  const t0 = Date.now();
  // sizeBefore is best-effort — file may not be on a POSIX FS in all envs.
  const dbPath = path.resolve('data/store.db');
  const sizeBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null;

  // SQLite's VACUUM is the canonical compaction. Prisma exposes it as
  // an unsafe raw exec (no parameters; no SQL injection risk — the
  // statement is a literal).
  await prisma.$executeRawUnsafe('VACUUM');

  const sizeAfter = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null;
  ctx.log.info('job.db_vacuum.done', {
    durationMs: Date.now() - t0,
    sizeBefore, sizeAfter,
    delta: sizeBefore !== null && sizeAfter !== null ? sizeAfter - sizeBefore : null,
  });
};

// ─── DB_BACKUP ─────────────────────────────────────────────────────────────

const BackupPayloadSchema = z.object({}).passthrough();
const BACKUP_DIR = path.resolve('data/backups');
const BACKUP_KEEP_DAYS = 30;

function backupStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${da}_${h}${mi}`;
}

export const dbBackupHandler: JobHandler<DbBackupPayload> = async (payload, ctx: JobContext) => {
  const parsed = BackupPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Invalid DB_BACKUP payload', { code: 'INVALID_JOB_PAYLOAD' });
  }
  await ctx.extendLock(ONE_HOUR_MS);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `auto_${backupStamp(new Date())}.db`);
  // Defensive: escape single-quotes in the path. Path is server-controlled
  // so injection is impossible, but the escape is cheap insurance.
  const safeDest = dest.replace(/'/g, "''");

  const t0 = Date.now();
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${safeDest}'`);
  } catch (e) {
    // VACUUM INTO can fail if the file already exists or disk is full.
    // Either way it's a real failure — let the runner retry.
    throw new InternalError(
      `DB_BACKUP: VACUUM INTO failed for ${dest}: ${(e as Error).message}`,
      { code: 'BACKUP_FAILED', cause: e },
    );
  }

  // Verify with a temporary Prisma client pointed at the backup file.
  // Pattern lifted from scripts/backup.ts.
  const verify = new PrismaClient({ datasources: { db: { url: `file:${dest}` } } });
  let integrity = 'unknown';
  try {
    const rows = await verify.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check');
    integrity = rows[0]?.integrity_check ?? 'unknown';
  } finally {
    await verify.$disconnect();
  }
  if (integrity !== 'ok') {
    // Clean up the bad backup so it doesn't sit in the rotation pool.
    try { fs.unlinkSync(dest); } catch { /* best-effort */ }
    throw new InternalError(
      `DB_BACKUP: integrity_check returned "${integrity}" for ${dest}`,
      { code: 'BACKUP_INTEGRITY_FAILED' },
    );
  }

  const size = fs.statSync(dest).size;
  const durationMs = Date.now() - t0;

  // Prune older backups (>30d). Only touch files matching our naming
  // convention — won't delete a hand-made backup if an admin dropped one.
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('auto_') || !f.endsWith('.db')) continue;
    const p = path.join(BACKUP_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) {
      fs.unlinkSync(p);
      pruned++;
    }
  }

  ctx.log.info('job.db_backup.done', { path: dest, sizeBytes: size, durationMs, prunedOldBackups: pruned });
};

// ─── AUDIT_LOG_ARCHIVE ─────────────────────────────────────────────────────

const ArchivePayloadSchema = z.object({
  retentionDays: z.number().int().positive().optional(),
});

const ARCHIVE_DIR = path.resolve('data/audit-archive');
const DEFAULT_RETENTION_DAYS = 90;

export const auditLogArchiveHandler: JobHandler<AuditLogArchivePayload> = async (
  payload, ctx: JobContext,
) => {
  const parsed = ArchivePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Invalid AUDIT_LOG_ARCHIVE payload', { code: 'INVALID_JOB_PAYLOAD' });
  }
  const retention = parsed.data.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000);

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  // Page through old audit rows in batches to bound memory (spec §5.3).
  const BATCH = 500;
  let totalArchived = 0;

  // Single archive file per run, timestamped.
  const stamp = backupStamp(new Date());
  const file = path.join(ARCHIVE_DIR, `auditlog_${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');

  try {
    // Loop until no more old rows.
    // Use a deterministic cursor (createdAt < cutoff) so we never re-read
    // the same rows after deletion — deleteMany after each batch shrinks
    // the candidate set monotonically.
    for (;;) {
      const batch = await prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      if (batch.length === 0) break;

      // Append each row as one JSON-line — easy to grep / pipe into jq.
      const ids: string[] = [];
      for (const row of batch) {
        fs.writeSync(fd, JSON.stringify(row) + '\n');
        ids.push(row.id);
      }
      await prisma.auditLog.deleteMany({ where: { id: { in: ids } } });
      totalArchived += batch.length;
      if (batch.length < BATCH) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  // If we archived nothing this run, remove the empty file so the archive
  // directory doesn't accumulate zero-byte droppings.
  if (totalArchived === 0) {
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
  }

  ctx.log.info('job.audit_log_archive.done', {
    retentionDays: retention,
    archived: totalArchived,
    archiveFile: totalArchived > 0 ? file : null,
  });
};
