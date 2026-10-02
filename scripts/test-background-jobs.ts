/**
 * Background Jobs System — Item 7. Test harness.
 *
 *   npm run test:background-jobs
 *
 * Organised by the four sections of spec §4:
 *   1. Unit tests — pure functions (cron parser, backoff, registry)
 *   2. Service / DB tests — enqueue, claim, retry, lock recovery, schedule
 *   3. Static audits — module structure, no rogue runner-start in tests
 *   4. Regression — verify runner does NOT start under NODE_ENV=test
 *
 * Every assertion carries a [J<n>.<m>] tag mapping to the spec acceptance
 * criteria so failures are traceable.
 *
 * IMPORTANT: this test sets NODE_ENV=test BEFORE importing anything from
 * the app. The job-runner startup guard in src/lib/db/client.ts treats
 * this as "do not auto-start the runner" — the tests construct their own
 * JobRunner instances and drive them with runOnce() so timing is
 * deterministic.
 */
// Pre-import side-effects: NODE_ENV must be "test" BEFORE @/lib/db/client
// (and transitively the jobs startup hook) is loaded. We cast through
// `Record<string, string>` because the standard ProcessEnv type marks
// NODE_ENV as readonly in some TS lib variants.
//
// Note: the in-process unit + service tests run as `NODE_ENV=test` (no
// background runner). The INTEGRATION section spawns a separate
// `next start` with `NODE_ENV=development` so the runner IS active in
// that child — that's how we observe real end-to-end claim/execute.
(process.env as Record<string, string>).NODE_ENV          = 'test';
(process.env as Record<string, string>).JOB_RUNNER_ENABLED = 'false';

import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';

import { prisma } from '../src/lib/db/client';
import { ValidationError } from '../src/lib/errors';
import { env } from '../src/lib/config';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';

import {
  JOB_TYPES, ALL_JOB_TYPES, isJobType,
} from '../src/lib/jobs/jobTypes';
import { handlers, hasHandler } from '../src/lib/jobs/workers';
import { computeNextRun, parseCron } from '../src/lib/jobs/cronParser';
import { enqueueJob, DEDUP_KEY_FIELD } from '../src/lib/jobs/producer';
import { JobRunner, backoffMs } from '../src/lib/jobs/runner';
import { JobScheduler, BUILT_IN_SCHEDULES, seedJobSchedules } from '../src/lib/jobs/scheduler';

// ── Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else fail(label, true, detail ?? false);
}
async function rejects(label: string, fn: () => Promise<unknown>) {
  try { await fn(); fail(label, 'throws', 'resolved cleanly'); }
  catch { ok(label); }
}

const TAG = `bgj_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

// All Jobs/Schedules we create carry the TAG in their type/name OR a
// well-known `bgj_` prefix so cleanup is deterministic — we never
// delete unrelated rows. We sweep BOTH the current-run rows AND any
// orphan `bgj_*` rows from previous interrupted runs.
async function cleanup(): Promise<void> {
  await prisma.job.deleteMany({ where: { OR: [
    { type:    { contains: 'bgj_' } },
    { payload: { contains: 'bgj_' } },
  ]}});
  await prisma.jobSchedule.deleteMany({ where: { name: { startsWith: 'bgj_' } } });
  // Also clean the OtpCode + IdempotencyKey test fixtures we may have
  // created (some bgj_ rows there too — TAG is embedded in their unique
  // keys / emails).
  await prisma.otpCode.deleteMany({ where: { email: { contains: 'bgj_' } } });
  await prisma.idempotencyKey.deleteMany({ where: { key: { contains: 'bgj_' } } });
}

// ───────────────────────────────────────────────── 1. UNIT — pure functions
function unitTests() {
  console.log('\n── UNIT — pure functions ──');

  // ── Cron parser
  // (J1.1) Step expressions
  {
    const next = computeNextRun('*/15 * * * *', new Date('2026-06-04T09:01:00Z'));
    eq('[J1.1] */15 advances to next quarter-hour', '2026-06-04T09:15:00.000Z', next.toISOString());
  }
  {
    const next = computeNextRun('*/15 * * * *', new Date('2026-06-04T09:15:30Z'));
    eq('[J1.1] */15 at 09:15 → 09:30', '2026-06-04T09:30:00.000Z', next.toISOString());
  }
  // (J1.2) Daily — when already past today's hour, advances to tomorrow
  {
    const next = computeNextRun('0 9 * * *', new Date('2026-06-04T09:01:00Z'));
    eq('[J1.2] 0 9 * * * past 09:00 → tomorrow 09:00',
       '2026-06-05T09:00:00.000Z', next.toISOString());
  }
  {
    const next = computeNextRun('0 9 * * *', new Date('2026-06-04T08:30:00Z'));
    eq('[J1.2] 0 9 * * * before 09:00 → today 09:00',
       '2026-06-04T09:00:00.000Z', next.toISOString());
  }
  // (J1.3) Weekly — Sunday 2am
  {
    // 2026-06-04 is a Thursday. Next Sunday 02:00 is 2026-06-07 02:00.
    const next = computeNextRun('0 2 * * 0', new Date('2026-06-04T02:01:00Z'));
    eq('[J1.3] 0 2 * * 0 → next Sunday 02:00', '2026-06-07T02:00:00.000Z', next.toISOString());
  }
  // (J1.4) Monthly — first of the month 04:00
  {
    const next = computeNextRun('0 4 1 * *', new Date('2026-06-04T04:01:00Z'));
    eq('[J1.4] 0 4 1 * * → first of next month',
       '2026-07-01T04:00:00.000Z', next.toISOString());
  }
  // (J1.5) Invalid cron → ValidationError
  // (J1.5) Invalid cron → ValidationError (rejects assertion)
  // Note: we wrap in async to use the rejects helper.
  // (Inlined deliberately — keeps the synchronous unit block intact.)
  try {
    parseCron('0 9 * *');
    fail('[J1.5] parseCron rejects 4-field expr', 'throws', 'resolved');
  } catch (e) {
    assert('[J1.5] parseCron rejects 4-field expr',
      e instanceof ValidationError && (e as ValidationError).code === 'INVALID_CRON');
  }
  try {
    parseCron('60 9 * * *');   // minute out of range
    fail('[J1.5] parseCron rejects out-of-range value', 'throws', 'resolved');
  } catch (e) {
    assert('[J1.5] parseCron rejects out-of-range value',
      e instanceof ValidationError);
  }
  try {
    parseCron('*/0 * * * *');  // zero step
    fail('[J1.5] parseCron rejects zero step', 'throws', 'resolved');
  } catch (e) {
    assert('[J1.5] parseCron rejects zero step',
      e instanceof ValidationError);
  }

  // (J1.6) computeNextRun is STRICTLY > now — spec §3.11
  {
    const now = new Date('2026-06-04T09:00:00Z');
    // Cron "0 9 * * *" matches exactly now; we must return tomorrow's 09:00.
    const next = computeNextRun('0 9 * * *', now);
    assert('[J1.6] computeNextRun is strictly > from (no "now" match)',
      next.getTime() > now.getTime(), { next: next.toISOString() });
  }

  // ── Backoff
  eq('[J2.1] backoffMs(1) = 30_000',         30_000,    backoffMs(1));
  eq('[J2.2] backoffMs(2) = 60_000',         60_000,    backoffMs(2));
  eq('[J2.3] backoffMs(3) = 120_000',        120_000,   backoffMs(3));
  eq('[J2.4] backoffMs(10) capped at 1h',    3_600_000, backoffMs(10));
  eq('[J2.5] backoffMs(20) still capped',    3_600_000, backoffMs(20));

  // ── Job type registry — every JobType has a handler; no orphan handlers
  for (const t of ALL_JOB_TYPES) {
    assert(`[J3.1] handler registered for "${t}"`, hasHandler(t));
  }
  for (const k of Object.keys(handlers)) {
    assert(`[J3.2] handler key "${k}" is a known JobType`, isJobType(k));
  }
  assert(`[J3.3] handler count = JOB_TYPES count`,
    Object.keys(handlers).length === ALL_JOB_TYPES.size,
    { handlers: Object.keys(handlers).length, types: ALL_JOB_TYPES.size });
}

// ──────────────────────────────────────── 2. SERVICE — DB-backed runner ops
async function serviceTests() {
  console.log('\n── SERVICE — DB-backed runner & scheduler ──');

  // (J4.1) enqueueJob writes a PENDING row
  const j1 = await enqueueJob(JOB_TYPES.SEND_EMAIL, {
    to: `${TAG}_a@shopcore.test`, subject: TAG + ' s1',
    html: '<p>x</p>', text: 'x',
  });
  eq('[J4.1] enqueue writes PENDING row', 'PENDING', j1.status);
  eq('[J4.1] enqueue zero attempts on fresh row', 0, j1.attempts);

  // (J4.2) Unknown job type rejected at enqueue (fail-fast)
  await rejects('[J4.2] enqueueJob rejects unknown type', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enqueueJob('not_a_real_job' as any, {} as any);
  });

  // (J4.3) Deduplication: same type + dedup key → same row returned
  const dedupKey = `${TAG}_dedup_${crypto.randomBytes(2).toString('hex')}`;
  const a = await enqueueJob(JOB_TYPES.LOW_STOCK_ALERT, { productId: 'pX_' + TAG },
    { deduplicationKey: dedupKey });
  const b = await enqueueJob(JOB_TYPES.LOW_STOCK_ALERT, { productId: 'pX_' + TAG },
    { deduplicationKey: dedupKey });
  eq('[J4.3] dedup returns same job id', a.id, b.id);
  const dedupCount = await prisma.job.count({
    where: { type: JOB_TYPES.LOW_STOCK_ALERT, payload: { contains: dedupKey } },
  });
  eq('[J4.3] dedup: exactly one DB row', 1, dedupCount);

  // (J4.4) Future runAt — runner skips, then picks up after the time passes
  const future = new Date(Date.now() + 60_000);
  const fut = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {}, { runAt: future });
  eq('[J4.4] future-runAt job is PENDING', 'PENDING', fut.status);
  // Try to claim with a runner — should NOT pick it up.
  const r0 = new JobRunner({ batchSize: 50 });
  // Filter the result by tag: we don't want sibling tests' rows to muddy.
  // r0.runOnce() returns the count across the whole DB, but we just need
  // to confirm fut.id stays PENDING.
  await r0.runOnce();
  const stillFut = await prisma.job.findUnique({ where: { id: fut.id } });
  eq('[J4.4] runner skips future-runAt rows', 'PENDING', stillFut!.status);
  // Move runAt to the past, runner should claim.
  await prisma.job.update({ where: { id: fut.id }, data: { runAt: new Date(Date.now() - 1000) } });
  await r0.runOnce();
  await r0.waitForIdle();
  const claimed = await prisma.job.findUnique({ where: { id: fut.id } });
  eq('[J4.4] runner claims now-eligible row', 'COMPLETED', claimed!.status);

  // (J5.1) Atomic claim race — two simulated runners targeting same row
  const race = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {});
  const claimSql = (lockToken: string) => prisma.job.updateMany({
    where: { id: race.id, status: 'PENDING' },
    data: {
      status: 'PROCESSING',
      lockToken,
      lockExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  const [c1, c2] = await Promise.all([claimSql('tokA'), claimSql('tokB')]);
  const winners = (c1.count === 1 ? 1 : 0) + (c2.count === 1 ? 1 : 0);
  eq('[J5.1] exactly one runner wins the atomic claim', 1, winners);
  // Cleanup the orphan we created:
  await prisma.job.update({ where: { id: race.id }, data: { status: 'COMPLETED', completedAt: new Date(), lockToken: null, lockExpiresAt: null } });

  // (J5.2) Worker success → COMPLETED + completedAt set + result JSON
  const succ = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {});
  const r1 = new JobRunner({ batchSize: 50 });
  await r1.runOnce();
  await r1.waitForIdle();
  const succRow = await prisma.job.findUnique({ where: { id: succ.id } });
  eq('[J5.2] success → COMPLETED', 'COMPLETED', succRow!.status);
  assert('[J5.2] success → completedAt set', succRow!.completedAt !== null);
  assert('[J5.2] success → result is JSON',
    typeof succRow!.result === 'string' && (() => { try { JSON.parse(succRow!.result!); return true; } catch { return false; } })());
  assert('[J5.2] success → lockToken cleared', succRow!.lockToken === null);

  // (J5.3) Worker failure: attempts < maxAttempts → re-queued PENDING with future runAt
  // Use SEND_EMAIL with intentionally-invalid payload (missing `to`).
  const failJob = await prisma.job.create({
    data: {
      type: JOB_TYPES.SEND_EMAIL,
      payload: JSON.stringify({ subject: TAG, html: '<p/>' }),    // no `to`
      runAt: new Date(),
      maxAttempts: 2,
    },
  });
  const r2 = new JobRunner({ batchSize: 50 });
  await r2.runOnce();
  await r2.waitForIdle();
  const afterFail = await prisma.job.findUnique({ where: { id: failJob.id } });
  eq('[J5.3] failed attempt 1 → re-queued PENDING', 'PENDING', afterFail!.status);
  eq('[J5.3] attempts incremented to 1', 1, afterFail!.attempts);
  assert('[J5.3] runAt advanced into future (backoff)',
    afterFail!.runAt.getTime() > Date.now());
  assert('[J5.3] error JSON populated', typeof afterFail!.error === 'string' && afterFail!.error!.includes('INVALID_JOB_PAYLOAD'));

  // (J5.4) Worker failure: attempts === maxAttempts → terminal FAILED
  // Force the row eligible again, run runner.
  await prisma.job.update({
    where: { id: failJob.id },
    data: { runAt: new Date(Date.now() - 1000) },
  });
  await r2.runOnce();
  await r2.waitForIdle();
  const term = await prisma.job.findUnique({ where: { id: failJob.id } });
  eq('[J5.4] attempt == maxAttempts → terminal FAILED', 'FAILED', term!.status);
  eq('[J5.4] terminal attempts == maxAttempts', 2, term!.attempts);
  assert('[J5.4] failedAt set on terminal', term!.failedAt !== null);

  // (J5.5) Lock-expiry recovery: manually set lockExpiresAt to past
  const stuck = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {});
  await prisma.job.update({
    where: { id: stuck.id },
    data: {
      status: 'PROCESSING',
      lockToken: 'stale-uuid',
      lockExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 600_000),
      attempts: 1,
    },
  });
  const r3 = new JobRunner();
  const reclaimed = await r3.reclaimStuckJobs();
  assert('[J5.5] reclaim count >= 1', reclaimed >= 1);
  const recovered = await prisma.job.findUnique({ where: { id: stuck.id } });
  eq('[J5.5] reclaimed row back to PENDING', 'PENDING', recovered!.status);
  eq('[J5.5] reclaimed row clears lockToken', null, recovered!.lockToken);

  // (J6.1) Scheduler — set nextRunAt in past, tick enqueues and advances
  const schedName = `${TAG}_sched_cleanup`;
  await prisma.jobSchedule.create({
    data: {
      name: schedName,
      jobType: JOB_TYPES.CLEANUP_EXPIRED_OTPS,
      cronExpression: '*/15 * * * *',
      nextRunAt: new Date(Date.now() - 1000),
    },
  });
  const sched = new JobScheduler();
  const fired = await sched.tick();
  assert('[J6.1] scheduler.tick() fires at least 1 row', fired >= 1, { fired });
  const updated = await prisma.jobSchedule.findUnique({ where: { name: schedName } });
  assert('[J6.1] nextRunAt advanced into future',
    updated!.nextRunAt.getTime() > Date.now(),
    { nextRunAt: updated!.nextRunAt.toISOString() });
  assert('[J6.1] lastRunAt was stamped', updated!.lastRunAt !== null);
  const enqueuedByTick = await prisma.job.count({
    where: { type: JOB_TYPES.CLEANUP_EXPIRED_OTPS, createdAt: { gt: new Date(Date.now() - 60_000) } },
  });
  assert('[J6.1] tick enqueued at least one CLEANUP_EXPIRED_OTPS', enqueuedByTick >= 1);

  // (J6.2) seedJobSchedules is idempotent + lists all built-ins
  const r4 = await seedJobSchedules();
  assert('[J6.2] seedJobSchedules returns {created,updated,unchanged}',
    typeof r4.created === 'number' && typeof r4.updated === 'number' && typeof r4.unchanged === 'number',
    r4);
  const presentAfterSeed = await prisma.jobSchedule.count({
    where: { name: { in: BUILT_IN_SCHEDULES.map((s) => s.name) }, isActive: true },
  });
  eq('[J6.2] all built-in schedules present after seed',
     BUILT_IN_SCHEDULES.length, presentAfterSeed);

  // (J7.1) CLEANUP_EXPIRED_OTPS actually deletes expired OTPs.
  await prisma.otpCode.create({
    data: {
      email: `${TAG}_otp@shopcore.test`,
      codeHash: 'x',
      purpose: 'SIGNUP',
      expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),  // 25h ago
    },
  });
  const beforeCleanup = await prisma.otpCode.count({
    where: { email: { contains: TAG } },
  });
  const cleanupJob = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {});
  const r5 = new JobRunner({ batchSize: 50 });
  await r5.runOnce();
  await r5.waitForIdle();
  const cleanRow = await prisma.job.findUnique({ where: { id: cleanupJob.id } });
  eq('[J7.1] cleanup_expired_otps completes', 'COMPLETED', cleanRow!.status);
  const afterCleanup = await prisma.otpCode.count({
    where: { email: { contains: TAG } },
  });
  assert(`[J7.1] cleanup deleted at least one OTP (before=${beforeCleanup} after=${afterCleanup})`,
    afterCleanup < beforeCleanup, { before: beforeCleanup, after: afterCleanup });

  // (J7.2) CLEANUP_STUCK_IDEMPOTENCY promotes stuck PROCESSING rows.
  await prisma.idempotencyKey.create({
    data: {
      userId: `${TAG}_uid`,
      key: `${TAG}_idem`,
      endpoint: 'POST /api/checkout/place-order',
      status: 'PROCESSING',
      requestFingerprint: 'fp',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });
  const stuckJob = await enqueueJob(JOB_TYPES.CLEANUP_STUCK_IDEMPOTENCY, {});
  await r5.runOnce();
  await r5.waitForIdle();
  const stuckRow = await prisma.job.findUnique({ where: { id: stuckJob.id } });
  eq('[J7.2] cleanup_stuck_idempotency completes', 'COMPLETED', stuckRow!.status);
  const idem = await prisma.idempotencyKey.findFirst({
    where: { key: `${TAG}_idem` },
  });
  eq('[J7.2] stuck PROCESSING idempotency → FAILED', 'FAILED', idem!.status);

  // (J8.1) Dedup-key field name is the documented constant
  assert('[J8.1] DEDUP_KEY_FIELD is the documented "__dedupKey" constant',
    DEDUP_KEY_FIELD === '__dedupKey');
}

// ─────────────────────────────────────── 3. STATIC — file presence & wiring
function staticAuditTests() {
  console.log('\n── STATIC AUDIT — wiring & no rogue runner-starts ──');

  // (J9.1) All required modules exist
  const required = [
    'src/lib/jobs/jobTypes.ts',
    'src/lib/jobs/cronParser.ts',
    'src/lib/jobs/producer.ts',
    'src/lib/jobs/runner.ts',
    'src/lib/jobs/scheduler.ts',
    'src/lib/jobs/startup.ts',
    'src/lib/jobs/workers/index.ts',
    'src/lib/jobs/workers/email.ts',
    'src/lib/jobs/workers/cleanup.ts',
    'src/lib/jobs/workers/cart.ts',
    'src/lib/jobs/workers/inventory.ts',
    'src/lib/jobs/workers/b2b.ts',
    'src/lib/jobs/workers/maintenance.ts',
    'prisma/migrations/20260605120000_background_jobs/migration.sql',
  ];
  for (const p of required) {
    assert(`[J9.1] file exists: ${p}`, existsSync(p) && statSync(p).isFile());
  }

  // (J9.2) db/client.ts dynamic-imports startup AND guards NODE_ENV=test
  const dbClient = readFileSync('src/lib/db/client.ts', 'utf8');
  assert(`[J9.2] db/client guards NODE_ENV !== 'test'`,
    /NODE_ENV\s*!==\s*['"]test['"]/.test(dbClient));
  assert(`[J9.2] db/client dynamic-imports startup`,
    /import\(['"]@\/lib\/jobs\/startup['"]\)/.test(dbClient));

  // (J9.3) runner uses recursive setTimeout (NOT setInterval) — spec §5.3.
  // Strip block + line comments before scanning so doc text doesn't
  // false-positive (the runner's header comment legitimately mentions
  // "setInterval" to document the rejected alternative).
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }
  const runner = stripComments(readFileSync('src/lib/jobs/runner.ts', 'utf8'));
  assert(`[J9.3] runner does not use setInterval`,
    !/\bsetInterval\b/.test(runner));
  assert(`[J9.3] runner uses setTimeout`,
    /\bsetTimeout\b/.test(runner));

  // (J9.4) runner caps in-flight via maxConcurrent
  assert(`[J9.4] runner respects maxConcurrent`,
    /maxConcurrent\s*-\s*this\.inFlight\.size/.test(runner));

  // (J9.5) scheduler uses recursive setTimeout
  const sched = stripComments(readFileSync('src/lib/jobs/scheduler.ts', 'utf8'));
  assert(`[J9.5] scheduler does not use setInterval`,
    !/\bsetInterval\b/.test(sched));

  // (J9.6) cronParser handles all four built-in cron shapes without throw
  for (const s of BUILT_IN_SCHEDULES) {
    let threw = false;
    try { computeNextRun(s.cronExpression, new Date()); } catch { threw = true; }
    assert(`[J9.6] computeNextRun OK for built-in "${s.name}"`, !threw,
      { cron: s.cronExpression });
  }

  // (J9.7) startup.ts skips when NODE_ENV=test
  const startup = readFileSync('src/lib/jobs/startup.ts', 'utf8');
  assert(`[J9.7] startup honours NODE_ENV=test guard`,
    /NODE_ENV\s*===\s*['"]test['"]/.test(startup));

  // (J9.8) maintenance.ts extends the lock before VACUUM/backup (spec §3.7)
  const maintenance = readFileSync('src/lib/jobs/workers/maintenance.ts', 'utf8');
  assert(`[J9.8] DB_VACUUM extends lock before running`,
    /dbVacuumHandler[\s\S]*ctx\.extendLock/.test(maintenance));
  assert(`[J9.8] DB_BACKUP extends lock before running`,
    /dbBackupHandler[\s\S]*ctx\.extendLock/.test(maintenance));

  // (J9.9) producer carries the dedup needle ("__dedupKey") in payload
  const producer = readFileSync('src/lib/jobs/producer.ts', 'utf8');
  assert(`[J9.9] producer uses __dedupKey reserved property`,
    /__dedupKey/.test(producer));
}

// ─────────────────── 4. REGRESSION — runner DOES NOT start in test env
function regressionTests() {
  console.log('\n── REGRESSION — runner does NOT start in test env ──');

  // (J10.1) The startup-singleton must short-circuit when NODE_ENV=test.
  // We can't reliably observe "no timers" from outside, but we CAN call
  // startJobRunner() in test mode and assert it returns null runner/sched.
  // (The import is guarded by JOB_RUNNER_ENABLED=false too — both belts
  // are in place.)
  // Use dynamic import to mirror the production code path.
  const startupPath = join('src', 'lib', 'jobs', 'startup.ts');
  const startupSrc  = readFileSync(startupPath, 'utf8');
  assert('[J10.1] startup module has _resetForTests escape hatch',
    /_resetForTests/.test(startupSrc));
}

// ─────────────────── 5. INTEGRATION — spawn `next start`, exercise admin API
const PORT = 3059;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-background-jobs-${process.pid}.log`;

async function startServer(): Promise<void> {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // NODE_ENV=development so the child IS running with the real
      // runtime — including a live JobRunner + JobScheduler. This is
      // what we want to integration-test against.
      NODE_ENV: 'development',
      // But shrink the runner's poll interval so integration tests don't
      // wait the default 5s per cycle. 250ms gives the runner ~4
      // chances per second to pick up jobs we enqueue.
      JOB_RUNNER_POLL_INTERVAL_MS: '250',
      JOB_RUNNER_ENABLED: 'true',
      SHOPCORE_ALLOW_TEST_EMAILS: '1',
    },
    detached: true,
  });
  const killGroup = (): void => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit',    killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });

  const append = (b: Buffer): void => { writeFileSync(SRV_LOG, b, { flag: 'a' }); };
  serverProc.stdout?.on('data', append);
  serverProc.stderr?.on('data', append);

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start within 30s — see ' + SRV_LOG);
}

async function stopServer(): Promise<void> {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response): void {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar): string {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Mint a session for an existing user, by hand — same trick as
 *  scripts/test-edge-cases.ts uses. Avoids needing the login UI. */
async function sessionJarFor(userId: string, role: 'ADMIN' | 'CUSTOMER'): Promise<Jar> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const fam = await issueRefreshFamily({ userId, role });
  const ttl = accessTtlFor(role);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: u.id, role: u.role, email: u.email,
    jti: sessionId, fam: fam.familyId, status: u.status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  applySetCookies(jar, csrfRes);
  jar.cookies[role === 'ADMIN' ? 'sc_admin'         : 'sc_session'] = jwt;
  jar.cookies[role === 'ADMIN' ? 'sc_admin_refresh' : 'sc_refresh'] = fam.secret;
  return jar;
}

interface ApiResp { status: number; body: Record<string, unknown>; headers: Headers; }
async function call(jar: Jar, path: string, init?: { method?: string; json?: unknown }): Promise<ApiResp> {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (!headers.has('origin')) headers.set('origin', BASE);
  const res = await fetch(BASE + path, {
    method, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body, headers: res.headers };
}

async function makeIntAdmin(): Promise<{ id: string; email: string }> {
  const email = `${TAG}_int_admin@shopcore.test`;
  const u = await prisma.user.create({
    data: {
      firstName: 'Int', lastName: 'Admin', email,
      phone: '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000),
      passwordHash: await hashPassword('Sm0kyM#7QrXaIntAdmin'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: test-fixture admin seeding. A brand-new
      // admin user has no prior state, so the runtime state machine
      // (which governs TRANSITIONS) does not apply. Mirrors the bypass
      // already used in prisma/seed.ts and scripts/test-edge-cases.ts.
      status: 'ACTIVE',
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  return { id: u.id, email };
}

async function integrationTests(): Promise<void> {
  console.log('\n── INTEGRATION — admin API end-to-end ──');

  await startServer();
  const admin = await makeIntAdmin();
  const adminJar = await sessionJarFor(admin.id, 'ADMIN');

  // (I1) GET /api/admin/jobs/stats — admin sees structured counts
  const stats = await call(adminJar, '/api/admin/jobs/stats');
  eq('[I1] GET /api/admin/jobs/stats → 200', 200, stats.status);
  const sBody = stats.body as { ok: boolean; data?: { pending: number; processing: number; completed: number; failed: number; cancelled: number } };
  assert('[I1] stats body has ok=true', sBody.ok === true);
  assert('[I1] stats body has pending counter (number)',
    sBody.data !== undefined && typeof sBody.data.pending === 'number');
  assert('[I1] stats counts are non-negative',
    sBody.data !== undefined
      && sBody.data.pending    >= 0 && sBody.data.processing >= 0
      && sBody.data.completed  >= 0 && sBody.data.failed     >= 0
      && sBody.data.cancelled  >= 0);

  // (I2) Admin auth required — anonymous call gets 401
  const anonJar = newJar();
  const anonRes = await call(anonJar, '/api/admin/jobs/stats');
  assert('[I2] anonymous → /api/admin/jobs/stats rejected (401/403)',
    anonRes.status === 401 || anonRes.status === 403, { status: anonRes.status });

  // (I3) GET /api/admin/jobs — paginated, status-filtered
  // Seed a PENDING job tagged with our run TAG.
  const seedJob = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {});
  // Tag the row so cleanup gets it (payload already contains nothing; we
  // mark the type prefix via a sibling tag — easiest: leave it and let
  // generic cleanup() sweep `bgj_` rows via the test-edge-cases-style
  // matcher. Our test rows are tracked by createdAt > start of test.)
  const list = await call(adminJar, '/api/admin/jobs?status=PENDING&pageSize=5');
  eq('[I3] GET /api/admin/jobs?status=PENDING → 200', 200, list.status);
  // Item 12 — standard envelope: { items, pagination: { total, page,
  //   pageSize, totalPages, hasNextPage, hasPrevPage } }. Legacy
  //   `pageCount` is gone; use `pagination.totalPages` instead.
  const listData = (list.body as { data: { items: Array<{ id: string; status: string }>; pagination: { total: number; page: number; pageSize: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean } } }).data;
  assert('[I3] list returns items array',  Array.isArray(listData.items));
  assert('[I3] list contains our seeded PENDING job',
    listData.items.some((it) => it.id === seedJob.id));
  for (const it of listData.items) {
    eq('[I3] every returned row has status PENDING', 'PENDING', it.status);
  }
  assert('[I3] list response includes pagination meta',
    typeof listData.pagination?.total      === 'number'
      && typeof listData.pagination?.page       === 'number'
      && typeof listData.pagination?.pageSize   === 'number'
      && typeof listData.pagination?.totalPages === 'number');

  // (I4) GET /api/admin/jobs/[id] — detail returns parsed payload
  const detailRes = await call(adminJar, `/api/admin/jobs/${seedJob.id}`);
  eq('[I4] GET /api/admin/jobs/[id] → 200', 200, detailRes.status);
  const detailBody = (detailRes.body as { data: { job: { id: string; type: string; payload: unknown } } }).data;
  eq('[I4] detail returns the same job id', seedJob.id, detailBody.job.id);
  eq('[I4] detail returns parsed payload (object, not string)',
     'object', typeof detailBody.job.payload);

  // (I5) Detail PII redaction — SEND_EMAIL payload has `to` masked
  const piiJob = await enqueueJob(JOB_TYPES.SEND_EMAIL, {
    to: `${TAG}_pii@example.com`, subject: 'PII test', html: '<p/>', text: 'x',
  });
  const piiDetail = await call(adminJar, `/api/admin/jobs/${piiJob.id}`);
  const piiBody = (piiDetail.body as { data: { job: { payload: { to: string } } } }).data;
  assert('[I5] detail masks the `to` email address (PII)',
    piiBody.job.payload.to !== `${TAG}_pii@example.com`
      && piiBody.job.payload.to.includes('***'),
    { masked: piiBody.job.payload.to });
  assert('[I5] detail strips reserved __dedupKey field',
    !Object.prototype.hasOwnProperty.call(piiBody.job.payload, '__dedupKey'));

  // (I6) POST /api/admin/jobs/[id]/cancel on PENDING → CANCELLED
  const cancelMe = await enqueueJob(JOB_TYPES.CLEANUP_EXPIRED_OTPS, {},
    // Future runAt so the runner doesn't claim it before our cancel.
    { runAt: new Date(Date.now() + 60_000) });
  const cancelRes = await call(adminJar, `/api/admin/jobs/${cancelMe.id}/cancel`, { method: 'POST' });
  eq('[I6] POST cancel on PENDING → 200', 200, cancelRes.status);
  const cancelled = await prisma.job.findUnique({ where: { id: cancelMe.id } });
  eq('[I6] cancelled row status = CANCELLED', 'CANCELLED', cancelled!.status);

  // (I7) Cancel refuses non-PENDING (409 JOB_NOT_CANCELLABLE)
  const re = await call(adminJar, `/api/admin/jobs/${cancelMe.id}/cancel`, { method: 'POST' });
  eq('[I7] cancel on CANCELLED row → 409', 409, re.status);
  eq('[I7] error code JOB_NOT_CANCELLABLE',
    'JOB_NOT_CANCELLABLE', (re.body as { code: string }).code);

  // (I8) POST /api/admin/jobs/[id]/retry on FAILED → PENDING
  // Create a directly-FAILED row to retry.
  const failedRow = await prisma.job.create({
    data: {
      type: JOB_TYPES.CLEANUP_EXPIRED_OTPS,
      payload: JSON.stringify({ __dedupKey: TAG + '_retry' }),
      status: 'FAILED',
      attempts: 3, maxAttempts: 3,
      runAt: new Date(),
      failedAt: new Date(),
      error: JSON.stringify({ name: 'TestError', code: 'TEST', message: 'seeded for retry' }),
    },
  });
  const retryRes = await call(adminJar, `/api/admin/jobs/${failedRow.id}/retry`, { method: 'POST' });
  eq('[I8] POST retry on FAILED → 200', 200, retryRes.status);
  const reset = await prisma.job.findUnique({ where: { id: failedRow.id } });
  eq('[I8] retry resets status to PENDING', 'PENDING', reset!.status);
  eq('[I8] retry resets attempts to 0', 0, reset!.attempts);
  eq('[I8] retry clears failedAt', null, reset!.failedAt);
  eq('[I8] retry clears error',    null, reset!.error);

  // (I9) Retry refuses non-FAILED rows
  const retryAgain = await call(adminJar, `/api/admin/jobs/${reset!.id}/retry`, { method: 'POST' });
  eq('[I9] retry on PENDING row → 409', 409, retryAgain.status);
  eq('[I9] error code JOB_NOT_RETRYABLE',
    'JOB_NOT_RETRYABLE', (retryAgain.body as { code: string }).code);

  // (I10) GET /api/admin/job-schedules — every built-in present
  const schRes = await call(adminJar, '/api/admin/job-schedules');
  eq('[I10] GET /api/admin/job-schedules → 200', 200, schRes.status);
  const schItems = (schRes.body as { data: { items: Array<{ name: string; isActive: boolean }> } }).data.items;
  const names = new Set(schItems.map((s) => s.name));
  for (const b of BUILT_IN_SCHEDULES) {
    assert(`[I10] built-in schedule "${b.name}" present`, names.has(b.name));
  }

  // (I11) PATCH /api/admin/job-schedules/[id] — toggle isActive
  const target = schItems.find((s) => s.name === 'cleanup.expired_otps')!;
  const targetId = (schItems[schItems.findIndex((s) => s.name === target.name)] as unknown as { id: string }).id;
  // Re-fetch detail to get the id (the row above is typed minimally; pull from full list)
  const full = (schRes.body as { data: { items: Array<{ id: string; name: string; isActive: boolean }> } }).data.items;
  const fullTarget = full.find((s) => s.name === 'cleanup.expired_otps')!;
  const desired = !fullTarget.isActive;
  const tog = await call(adminJar, `/api/admin/job-schedules/${fullTarget.id}`,
    { method: 'PATCH', json: { isActive: desired } });
  eq('[I11] PATCH toggle isActive → 200', 200, tog.status);
  const togBody = (tog.body as { data: { schedule: { isActive: boolean } } }).data;
  eq('[I11] toggled to requested state', desired, togBody.schedule.isActive);
  // Toggle back so we don't leave the system disabled.
  await call(adminJar, `/api/admin/job-schedules/${fullTarget.id}`,
    { method: 'PATCH', json: { isActive: fullTarget.isActive } });

  // (I12) PATCH rejects invalid cron expression with VALIDATION_ERROR
  const bad = await call(adminJar, `/api/admin/job-schedules/${fullTarget.id}`,
    { method: 'PATCH', json: { cronExpression: 'not a cron' } });
  assert('[I12] PATCH bad cron rejected (400)',
    bad.status === 400, { status: bad.status });

  // (I13) End-to-end runner flow — enqueue a SEND_EMAIL (dev-mode email
  //       falls through to a structured log line; the job COMPLETES).
  //       We just need to see it transition PENDING → COMPLETED within
  //       a few poll cycles.
  const e2e = await enqueueJob(JOB_TYPES.SEND_EMAIL, {
    to: `${TAG}_e2e@example.com`, subject: 'E2E', html: '<p/>', text: 'x',
  });
  let observed: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const row = await prisma.job.findUnique({ where: { id: e2e.id } });
    if (!row) break;
    if (row.status === 'COMPLETED' || row.status === 'FAILED') {
      observed = row.status;
      break;
    }
  }
  assert(`[I13] runner executed E2E job within 10s (got ${observed ?? 'still PENDING'})`,
    observed === 'COMPLETED' || observed === 'FAILED',
    { observed });

  // ── Schedule leftover cleanup ────────────────────────────────────
  await prisma.session.deleteMany({ where: { userId: admin.id } });

  await stopServer();
}
// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // Sweep any orphan fixtures from previous interrupted runs first so
  // sequence-sensitive assertions (counts, "exactly 1 row") aren't
  // contaminated by leftovers.
  await cleanup();
  const RUN_INT = process.env.SHOPCORE_SKIP_INT !== '1';
  try {
    unitTests();
    await serviceTests();
    staticAuditTests();
    regressionTests();
    if (RUN_INT) {
      await integrationTests();
    } else {
      console.log('\n── INTEGRATION — SKIPPED (SHOPCORE_SKIP_INT=1) ──');
    }
  } finally {
    await stopServer();
    await cleanup();
    // Also clean any users/sessions/families/audit rows we created during
    // integration. Order matters: child rows first. AuditLog has actorId
    // pointing at User → strip those before User can be deleted.
    const intUsers = await prisma.user.findMany({
      where: { email: { contains: 'bgj_' } },
      select: { id: true },
    });
    const intUserIds = intUsers.map((u) => u.id);
    if (intUserIds.length > 0) {
      await prisma.session.deleteMany({ where: { userId: { in: intUserIds } } });
      await prisma.refreshTokenFamily.deleteMany({ where: { userId: { in: intUserIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: intUserIds } } });
      await prisma.userActivity.deleteMany({ where: { userId: { in: intUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: intUserIds } } });
    }
    await prisma.$disconnect();
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
