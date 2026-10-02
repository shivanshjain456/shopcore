/**
 * Daily backup script. Run via cron / systemd timer:
 *
 *   0 2 * * *  cd /srv/shopcore && /usr/bin/env tsx scripts/backup.ts
 *
 * What it does:
 *  - Takes a CONSISTENT snapshot of data/store.db via Prisma's $queryRaw
 *    "VACUUM INTO" (safe while the app is running, unlike file copy).
 *  - Writes data/backups/store-YYYY-MM-DD-HHmm.db
 *  - Verifies the new file with PRAGMA integrity_check
 *  - Prunes anything older than 30 days
 *
 * Falls back to fs.copyFileSync if VACUUM INTO fails (e.g. older SQLite).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const SRC = path.resolve('data/store.db');
const DIR = path.resolve('data/backups');
const KEEP_DAYS = 30;

function stamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${da}-${h}${mi}`;
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('No DB file at', SRC);
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });
  const dest = path.join(DIR, `store-${stamp(new Date())}.db`);

  const prisma = new PrismaClient();
  let usedVacuum = false;
  try {
    // SQLite VACUUM INTO emits a consistent snapshot file
    await prisma.$queryRawUnsafe(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    usedVacuum = true;
  } catch (e) {
    console.warn('VACUUM INTO failed, falling back to file copy:', (e as Error).message);
    fs.copyFileSync(SRC, dest);
  } finally {
    await prisma.$disconnect();
  }

  // Verify via a temporary Prisma client pointing at the backup file
  const verify = new PrismaClient({ datasources: { db: { url: `file:${dest}` } } });
  try {
    const rows = await verify.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check');
    const status = rows[0]?.integrity_check ?? 'unknown';
    if (status !== 'ok') {
      console.error('Backup integrity check FAILED:', status);
      process.exit(2);
    }
  } catch (e) {
    console.error('Backup verification failed:', (e as Error).message);
    process.exit(2);
  } finally {
    await verify.$disconnect();
  }

  console.log(`✔ Backup OK (${usedVacuum ? 'VACUUM INTO' : 'file copy'}): ${dest}`);

  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.startsWith('store-') || !f.endsWith('.db')) continue;
    const p = path.join(DIR, f);
    const st = fs.statSync(p);
    if (st.mtimeMs < cutoff) {
      fs.unlinkSync(p);
      console.log('  pruned', f);
    }
  }

  // Prune expired idempotency keys (used by /api/checkout/place-order etc.)
  // Cheap & safe to run nightly alongside the backup job.
  try {
    const { pruneExpiredIdempotencyKeys } = await import('../src/lib/checkout/idempotency');
    const removed = await pruneExpiredIdempotencyKeys();
    if (removed > 0) console.log(`✔ Pruned ${removed} expired idempotency key(s)`);
  } catch (e) {
    console.warn('Idempotency prune skipped:', (e as Error).message);
  }

  // Prune refresh-token families whose absolute expiry passed > 7d ago.
  try {
    const { pruneExpiredRefreshFamilies } = await import('../src/lib/auth/refresh');
    const removed = await pruneExpiredRefreshFamilies();
    if (removed > 0) console.log(`✔ Pruned ${removed} expired refresh family/families`);
  } catch (e) {
    console.warn('Refresh-family prune skipped:', (e as Error).message);
  }

  // Prune express-checkout (Buy-Now) rows whose expiry passed > 7d ago.
  try {
    const { pruneExpiredExpressCheckouts } = await import('../src/lib/checkout/express');
    const removed = await pruneExpiredExpressCheckouts();
    if (removed > 0) console.log(`✔ Pruned ${removed} expired express-checkout row(s)`);
  } catch (e) {
    console.warn('Express-checkout prune skipped:', (e as Error).message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
