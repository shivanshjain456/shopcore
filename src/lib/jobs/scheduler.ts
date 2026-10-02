/**
 * Job Scheduler — translates `JobSchedule` rows (cron expressions) into
 * `enqueueJob` calls on the cadence defined by each row.
 *
 * Strategy:
 *   - Same recursive-setTimeout pattern as the runner — overlap-proof.
 *   - On each tick: find every ACTIVE schedule whose `nextRunAt <= now`,
 *     enqueue its job, then advance `lastRunAt` + `nextRunAt`.
 *   - `nextRunAt` is computed by `computeNextRun(cron, now)` which ALWAYS
 *     returns a future minute (spec §3.11 — never returns the present).
 *   - The scheduler does NOT execute jobs; it only enqueues them. The
 *     runner picks them up in its own poll.
 */
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { env } from '@/lib/config';
import { enqueueJob } from '@/lib/jobs/producer';
import { computeNextRun } from '@/lib/jobs/cronParser';
import {
  JOB_TYPES,
  isJobType,
  type JobType,
  type JobPayloadMap,
} from '@/lib/jobs/jobTypes';
import { hasHandler } from '@/lib/jobs/workers';

export interface JobSchedulerConfig {
  /** How often to scan the JobSchedule table for due rows. */
  tickIntervalMs: number;
}

export function defaultSchedulerConfig(): JobSchedulerConfig {
  return {
    // Reuse the runner's poll interval — both walk the same wall-clock cadence.
    tickIntervalMs: env.JOB_RUNNER_POLL_INTERVAL_MS,
  };
}

export class JobScheduler {
  private readonly config: JobSchedulerConfig;
  private running = false;
  private stopRequested = false;
  private nextTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<JobSchedulerConfig> = {}) {
    this.config = { ...defaultSchedulerConfig(), ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    log.info('job.scheduler.started', { tickIntervalMs: this.config.tickIntervalMs });
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.running = false;
    log.info('job.scheduler.stopped', {});
  }

  /** Public for tests — run a single scan pass. Returns # rows fired. */
  async tick(): Promise<number> {
    const now = new Date();
    const due = await prisma.jobSchedule.findMany({
      where: { isActive: true, nextRunAt: { lte: now } },
    });

    let fired = 0;
    for (const sched of due) {
      // Skip if the configured jobType is unknown — log loudly so this
      // can't sit silently for weeks. (Should never happen because
      // seed/preflight reject unknown types, but defensive.)
      if (!isJobType(sched.jobType) || !hasHandler(sched.jobType)) {
        log.warn('schedule.unknown_job_type', {
          scheduleName: sched.name,
          jobType:      sched.jobType,
        });
        continue;
      }

      // Compute the NEXT run BEFORE enqueue so we always advance even if
      // enqueue fails (a malformed cron would already have thrown at
      // upsert time, so computeNextRun here is purely arithmetic).
      let nextRunAt: Date;
      try {
        nextRunAt = computeNextRun(sched.cronExpression, now);
      } catch (e) {
        log.error('schedule.cron_parse_failed', {
          scheduleName: sched.name,
          cronExpression: sched.cronExpression,
          error: (e as Error).message,
        });
        // Pause the schedule so it doesn't tight-loop on a bad cron.
        await prisma.jobSchedule.update({
          where: { id: sched.id },
          data:  { isActive: false },
        });
        continue;
      }

      try {
        let payload: unknown = {};
        try {
          payload = JSON.parse(sched.payload);
        } catch {
          payload = {};
        }
        const jobType = sched.jobType as JobType;
        // `as never` for the generic — payload shape is enforced by the
        // worker's Zod schema at execute time, not by the scheduler.
        await enqueueJob(
          jobType,
          payload as JobPayloadMap[typeof jobType] & never,
          { queueName: sched.queueName },
        );
        fired++;
      } catch (e) {
        log.error('schedule.enqueue_failed', {
          scheduleName: sched.name,
          jobType:      sched.jobType,
          error:        (e as Error).message,
        });
        // fall through — still advance lastRunAt/nextRunAt so we don't
        // tight-loop on a permanently-failing enqueue.
      }

      await prisma.jobSchedule.update({
        where: { id: sched.id },
        data:  { lastRunAt: now, nextRunAt },
      });

      log.info('schedule.triggered', {
        scheduleName: sched.name,
        jobType:      sched.jobType,
        nextRunAt:    nextRunAt.toISOString(),
      });
    }

    return fired;
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopRequested) return;
    this.nextTimer = setTimeout(() => {
      void this.tickAndReschedule();
    }, delayMs);
    if (this.nextTimer.unref) this.nextTimer.unref();
  }

  private async tickAndReschedule(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      log.error('job.scheduler.tick_error', { error: (e as Error).message });
    }
    if (!this.stopRequested) {
      this.scheduleNextTick(this.config.tickIntervalMs);
    }
  }
}

/**
 * Static catalogue of built-in recurring schedules. Times are in UTC.
 * Spec §2.6 lists them in IST; the comment beside each cron expression
 * documents the conversion.
 *
 * Updating this list: change the entry, then call `seedJobSchedules()`
 * (idempotent upsert by `name`).
 */
export interface BuiltInSchedule {
  name:           string;
  jobType:        JobType;
  cronExpression: string;
  payload?:       string;
  queueName?:     string;
  /** Human-readable comment for docs / dashboard. */
  description:    string;
}

export const BUILT_IN_SCHEDULES: readonly BuiltInSchedule[] = [
  // Auth / hygiene
  { name: 'cleanup.expired_otps',           cronExpression: '*/15 * * * *', jobType: JOB_TYPES.CLEANUP_EXPIRED_OTPS,
    description: 'Delete consumed/expired OtpCode rows every 15 minutes.' },
  { name: 'cleanup.expired_sessions',       cronExpression: '0 * * * *',    jobType: JOB_TYPES.CLEANUP_EXPIRED_SESSIONS,
    description: 'Delete expired Session rows + expired RefreshTokenFamily children, hourly.' },
  { name: 'cleanup.expired_reset_tokens',   cronExpression: '*/30 * * * *', jobType: JOB_TYPES.CLEANUP_EXPIRED_RESET_TOKENS,
    description: 'Delete expired PasswordResetToken + mark PasswordResetRequest EXPIRED, every 30 min.' },
  // Checkout
  { name: 'cleanup.stuck_idempotency',      cronExpression: '*/5 * * * *',  jobType: JOB_TYPES.CLEANUP_STUCK_IDEMPOTENCY,
    description: 'Promote IdempotencyKey rows stuck in PROCESSING > 5min to FAILED, every 5 min.' },
  { name: 'checkout.abandoned_cart',        cronExpression: '0 */2 * * *',  jobType: JOB_TYPES.ABANDONED_CART_REMINDER,
    description: 'Scan stale carts (2-24h) and enqueue reminder emails, every 2 hours.' },
  // Inventory & B2B (UTC offsets for IST)
  { name: 'inventory.low_stock_alert',      cronExpression: '30 3 * * *',   jobType: JOB_TYPES.LOW_STOCK_ALERT,
    description: 'Daily 9:00 IST (= 03:30 UTC) — low-stock email to admins.' },
  { name: 'b2b.quote_expiry',               cronExpression: '30 4 * * *',   jobType: JOB_TYPES.B2B_QUOTE_EXPIRY,
    description: 'Daily 10:00 IST (= 04:30 UTC) — mark OPEN QuoteRequests >7d as EXPIRED.' },
  // Maintenance (UTC)
  { name: 'maintenance.db_vacuum',          cronExpression: '0 2 * * 0',    jobType: JOB_TYPES.DB_VACUUM,
    description: 'Weekly Sunday 02:00 UTC — VACUUM the SQLite DB.' },
  { name: 'maintenance.db_backup',          cronExpression: '0 3 * * *',    jobType: JOB_TYPES.DB_BACKUP,
    description: 'Daily 03:00 UTC — VACUUM INTO data/backups/, integrity-check, prune >30d.' },
  { name: 'maintenance.audit_archive',      cronExpression: '0 4 1 * *',    jobType: JOB_TYPES.AUDIT_LOG_ARCHIVE,
    description: 'Monthly 1st 04:00 UTC — export AuditLog rows >90d to JSONL and delete.' },
];

/**
 * Upsert all built-in schedules. Safe to call repeatedly (`@unique name`).
 * On first insert, `nextRunAt` is computed from `now()`. On re-run, an
 * existing row is updated only if its `cronExpression` differs (so an
 * admin's manual `isActive` toggle is preserved).
 */
export async function seedJobSchedules(): Promise<{ created: number; updated: number; unchanged: number }> {
  const now = new Date();
  let created = 0, updated = 0, unchanged = 0;
  for (const s of BUILT_IN_SCHEDULES) {
    const existing = await prisma.jobSchedule.findUnique({ where: { name: s.name } });
    if (!existing) {
      const nextRunAt = computeNextRun(s.cronExpression, now);
      await prisma.jobSchedule.create({
        data: {
          name:           s.name,
          jobType:        s.jobType,
          cronExpression: s.cronExpression,
          payload:        s.payload ?? '{}',
          queueName:      s.queueName ?? 'default',
          nextRunAt,
        },
      });
      created++;
    } else if (existing.cronExpression !== s.cronExpression || existing.jobType !== s.jobType) {
      const nextRunAt = computeNextRun(s.cronExpression, now);
      await prisma.jobSchedule.update({
        where: { id: existing.id },
        data:  { cronExpression: s.cronExpression, jobType: s.jobType, nextRunAt },
      });
      updated++;
    } else {
      unchanged++;
    }
  }
  return { created, updated, unchanged };
}
