/**
 * Restore script:
 *   tsx scripts/restore.ts <backupFile>
 *
 * Safety:
 *  - Refuses to run if the server appears to be up (data/store.db-journal exists
 *    or you pass --force).
 *  - Backs up the current data/store.db to data/backups/pre-restore-<ts>.db
 *    before overwriting.
 *  - Verifies the backup file's PRAGMA integrity_check first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'));

async function main() {
  if (!file) {
    console.error('Usage: tsx scripts/restore.ts <backup-file.db> [--force]');
    process.exit(1);
  }
  const src = path.resolve(file);
  if (!fs.existsSync(src)) {
    console.error('Backup file not found:', src);
    process.exit(1);
  }
  const dst = path.resolve('data/store.db');

  // Sanity: verify backup integrity first
  const verify = new PrismaClient({ datasources: { db: { url: `file:${src}` } } });
  try {
    const rows = await verify.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check');
    if (rows[0]?.integrity_check !== 'ok') {
      console.error('Backup integrity_check returned:', rows[0]?.integrity_check);
      process.exit(2);
    }
  } finally { await verify.$disconnect(); }

  // Refuse if server appears live
  if (fs.existsSync(dst + '-journal') && !force) {
    console.error('Detected open SQLite journal — server may be running. Stop it first or pass --force.');
    process.exit(3);
  }

  // Save pre-restore copy
  if (fs.existsSync(dst)) {
    const pre = path.resolve('data/backups', `pre-restore-${Date.now()}.db`);
    fs.mkdirSync(path.dirname(pre), { recursive: true });
    fs.copyFileSync(dst, pre);
    console.log('Saved pre-restore snapshot:', pre);
  }

  fs.copyFileSync(src, dst);
  console.log('✔ Restored', src, '→', dst);
}

main().catch((e) => { console.error(e); process.exit(1); });
