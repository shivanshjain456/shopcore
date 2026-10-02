/**
 * Production preflight — run before `npm start` in production.
 *
 *   npm run preflight
 *
 * Checks:
 *   1. .env loads cleanly (Zod-validated)
 *   2. Production-safety: secrets, SMTP, APP_URL scheme
 *   3. DB file exists and `PRAGMA integrity_check` returns "ok"
 *   4. StoreConfig singleton seeded
 *   5. At least one ACTIVE admin user exists
 *   6. Migrations applied (no drift)
 *
 * Exit 0 on success, non-zero with a clear message otherwise.
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { checkProductionSafety } from '../src/lib/boot';
import { env } from '../src/lib/config';

function red(s: string)   { return `\x1b[31m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string){ return `\x1b[33m${s}\x1b[0m`; }

async function main() {
  const issues: string[] = [];
  const warns: string[] = [];

  // 1) env (importing config above already ran Zod parse)
  console.log(green('✔'), `NODE_ENV=${env.NODE_ENV}`);

  // 2) production safety
  const safety = checkProductionSafety();
  if (env.NODE_ENV === 'production') {
    safety.problems.forEach((p) => issues.push(p));
  } else {
    safety.problems.forEach((p) => warns.push(p));
  }
  console.log(safety.ok ? green('✔ safety checks pass') : (env.NODE_ENV === 'production' ? red('✘ safety checks FAILED') : yellow('⚠ safety checks (dev — non-fatal):')));

  // 3-6) DB checks
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check');
    if (rows[0]?.integrity_check === 'ok') console.log(green('✔ DB integrity OK'));
    else issues.push(`PRAGMA integrity_check returned: ${rows[0]?.integrity_check}`);

    const cfg = await prisma.storeConfig.findUnique({ where: { id: 'singleton' } });
    if (cfg) console.log(green('✔ StoreConfig seeded'));
    else issues.push('StoreConfig missing — run `npm run db:seed`.');

    const adminCount = await prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
    if (adminCount > 0) console.log(green(`✔ ${adminCount} active admin(s)`));
    else issues.push('No active admin user — run `npm run db:seed` and change the password.');

    // ── Background Jobs (Item 7) health check ────────────────────────
    // We expect at least 5 ACTIVE schedules; the built-in list has 10.
    // Below 5 means seed wasn't run or somebody disabled everything.
    const scheduleCount = await prisma.jobSchedule.count({ where: { isActive: true } });
    if (scheduleCount >= 5) {
      console.log(green(`✔ ${scheduleCount} active job schedule(s)`));
    } else {
      issues.push(`Only ${scheduleCount} active job schedule(s) — run \`npm run db:seed\` or check the background_jobs migration.`);
    }

    // Stuck PROCESSING jobs (>1h since startedAt) indicate a previous
    // runner crash. The new runner reclaims these on startup so this
    // is a warning, not a fatal preflight failure.
    const stuckJobs = await prisma.job.count({
      where: { status: 'PROCESSING', startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (stuckJobs > 0) {
      warns.push(`${stuckJobs} job(s) stuck in PROCESSING > 1h — runner will reclaim on startup`);
    } else {
      console.log(green('✔ no stuck PROCESSING jobs'));
    }
  } catch (e) {
    issues.push('DB unreachable: ' + (e as Error).message);
  } finally {
    await prisma.$disconnect();
  }

  // 6) prisma migrate status (best-effort)
  const status = spawnSync('npx', ['prisma', 'migrate', 'status'], { encoding: 'utf8', shell: true });
  const output = (status.stdout ?? '') + (status.stderr ?? '') + (status.error ? String(status.error) : '');
  if (status.status === 0) console.log(green('✔ Prisma migrations up to date'));
  else warns.push('Prisma migrate status: ' + output.slice(0, 400));

  if (warns.length) {
    console.log('\n' + yellow('Warnings:'));
    warns.forEach((w) => console.log('  - ' + w));
  }
  if (issues.length) {
    console.log('\n' + red('Issues blocking startup:'));
    issues.forEach((w) => console.log('  - ' + w));
    process.exit(1);
  }
  console.log('\n' + green('All preflight checks passed.'));
}

main().catch((e) => { console.error(e); process.exit(1); });
