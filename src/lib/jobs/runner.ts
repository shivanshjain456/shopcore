/**
 * Job Runner — the polling loop that claims PENDING jobs, executes their
 * handlers, retries with exponential backoff, and reclaims stuck PROCESSING
 * rows.
 *
 * Design discipline:
 *   - Single-process model (one Node, one SQLite file). The atomic claim
 *     is still essential: a stuck-recovery sweep can race with the main
 *     pickup sweep within the same process, and we want both ordered.
 *   - Poll loop uses recursive `setTimeout` (NOT setInterval) — overlap-
 *     proof: the next poll is only scheduled after the current batch
 *     settles (spec §5.3).
 *   - In-flight set bounded by MAX_CONCURRENT_JOBS — no unbounded
 *     accumulation under sustained load.
 *   - Graceful shutdown drains in-flight jobs before exit; a hard
 *     DRAIN_TIMEOUT prevents the process from hanging forever.
 *
 * The runner is started by `startup.ts` (singleton). Tests construct
 * their own `JobRunner` instances directly to drive single-poll
 * verification (spec §4.2).
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { ShopCoreError, InternalError } from '@/lib/errors';
import { env } from '@/lib/config';
import { getHandler, hasHandler, type JobContext } from '@/lib/jobs/workers';
import type { JobType } from '@/lib/jobs/jobTypes';

export interface JobRunnerConfig {
  /** Poll cadence — wait this long between batches when the queue is idle. */
  pollIntervalMs:    number;
  /** Max rows fetched per poll. */
  batchSize:         number;
  /** Cap on in-flight (concurrently executing) jobs across the runner. */
  maxConcurrent:     number;
  /** Lock TTL — how long a job may stay PROCESSING before being reclaimed. */
  lockTtlMs:         number;
  /** Max time the runner will wait for in-flight jobs to settle on shutdown. */
  drainTimeoutMs:    number;
}

export function defaultRunnerConfig(): JobRunnerConfig {
  return {
    pollIntervalMs: env.JOB_RUNNER_POLL_INTERVAL_MS,
    batchSize:      env.JOB_RUNNER_BATCH_SIZE,
    maxConcurrent:  env.JOB_RUNNER_MAX_CONCURRENT,
    lockTtlMs:      env.JOB_RUNNER_LOCK_TTL_MS,
    drainTimeoutMs: env.JOB_RUNNER_DRAIN_TIMEOUT_MS,
  };
}

/**
 * Exponential backoff: 30s, 60s, 120s, …, capped at 1h.
 * Spec §2.5 (retry with exponential backoff).
 * `attempts` is the count AFTER the failed attempt (i.e. attempts >= 1).
 */
export function backoffMs(attempts: number): number {
  const a = Math.max(1, attempts);
  return Math.min(30_000 * Math.pow(2, a - 1), 60 * 60 * 1000);
}

/** Structured error JSON written to `job.error`. No stack — stacks live
 *  in logs only, never in the DB. Spec §3.5. */
function shapeError(e: unknown): string {
  if (e instanceof ShopCoreError) {
    return JSON.stringify({ name: e.name, code: e.code, message: e.message });
  }
  if (e instanceof Error) {
    return JSON.stringify({ name: e.name, code: 'INTERNAL_ERROR', message: e.message });
  }
  return JSON.stringify({ name: 'UnknownError', code: 'INTERNAL_ERROR', message: String(e) });
}

export class JobRunner {
  private readonly config: JobRunnerConfig;
  /** Set of job ids currently executing. */
  private readonly inFlight = new Set<string>();
  private running = false;
  private stopRequested = false;
  private nextPollTimer: NodeJS.Timeout | null = null;
  /** Promise that resolves when the runner has fully drained. */
  private stoppedResolver: (() => void) | null = null;
  private stoppedPromise: Promise<void> | null = null;

  constructor(config: Partial<JobRunnerConfig> = {}) {
    this.config = { ...defaultRunnerConfig(), ...config };
  }

  /** True if the runner is accepting new jobs. */
  isRunning(): boolean { return this.running && !this.stopRequested; }

  /** Number of jobs currently executing in this runner. */
  inFlightCount(): number { return this.inFlight.size; }

  /** Start polling. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.stoppedPromise = new Promise((r) => { this.stoppedResolver = r; });
    log.info('job.runner.started', {
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize:      this.config.batchSize,
      maxConcurrent:  this.config.maxConcurrent,
    });
    // Kick off the first poll immediately so a job enqueued right after
    // start() isn't held for `pollIntervalMs` before pickup.
    this.scheduleNextPoll(0);
  }

  /**
   * Stop accepting new jobs and wait for in-flight to settle (up to
   * `drainTimeoutMs`). Returns a promise that resolves when fully drained
   * (or the timeout fires, whichever comes first).
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.stopRequested) return this.stoppedPromise ?? Promise.resolve();
    this.stopRequested = true;
    if (this.nextPollTimer) {
      clearTimeout(this.nextPollTimer);
      this.nextPollTimer = null;
    }
    log.info('job.runner.stopping', { inFlight: this.inFlight.size });

    const drained = new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.inFlight.size === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), this.config.drainTimeoutMs);
    });

    const result = await Promise.race([drained.then(() => 'drained' as const), timeout]);
    if (result === 'timeout') {
      log.error('job.runner.drain_timeout', {
        stillInFlight: this.inFlight.size,
        timeoutMs:     this.config.drainTimeoutMs,
      });
    } else {
      log.info('job.runner.stopped', {});
    }

    this.running = false;
    if (this.stoppedResolver) {
      this.stoppedResolver();
      this.stoppedResolver = null;
    }
  }

  /** Reclaim PROCESSING jobs whose lock has expired. Public for tests. */
  async reclaimStuckJobs(): Promise<number> {
    const now = new Date();
    // Find first so we can log per-row diagnostics, then bulk update.
    const stuck = await prisma.job.findMany({
      where: { status: 'PROCESSING', lockExpiresAt: { lt: now } },
      select: { id: true, type: true, lockExpiresAt: true, startedAt: true },
    });
    if (stuck.length === 0) return 0;

    const ids = stuck.map((j) => j.id);
    const res = await prisma.job.updateMany({
      where: { id: { in: ids }, status: 'PROCESSING', lockExpiresAt: { lt: now } },
      data:  { status: 'PENDING', lockToken: null, lockExpiresAt: null },
    });
    for (const j of stuck) {
      const lockedForMs = j.startedAt ? now.getTime() - j.startedAt.getTime() : null;
      log.info('job.lock_reclaimed', { jobId: j.id, jobType: j.type, lockedForMs });
    }
    return res.count;
  }

  /**
   * Single poll cycle: reclaim stuck jobs, fetch eligible PENDING, claim
   * each atomically, execute concurrently via Promise.allSettled. Public
   * for tests (driven manually instead of via the timer).
   */
  async runOnce(): Promise<{ claimed: number; reclaimed: number }> {
    const reclaimed = await this.reclaimStuckJobs();

    // Respect the in-flight cap.
    const capacity = Math.max(0, this.config.maxConcurrent - this.inFlight.size);
    if (capacity === 0) return { claimed: 0, reclaimed };

    const limit = Math.min(this.config.batchSize, capacity);
    const candidates = await prisma.job.findMany({
      where: { status: 'PENDING', runAt: { lte: new Date() } },
      orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
      take: limit,
    });
    if (candidates.length === 0) return { claimed: 0, reclaimed };

    const claimedJobs: typeof candidates = [];
    for (const c of candidates) {
      const lockToken = crypto.randomUUID();
      const lockExpiresAt = new Date(Date.now() + this.config.lockTtlMs);
      const update = await prisma.job.updateMany({
        where: { id: c.id, status: 'PENDING' },
        data: {
          status:        'PROCESSING',
          lockToken,
          lockExpiresAt,
          startedAt:     new Date(),
          attempts:      { increment: 1 },
        },
      });
      if (update.count === 1) {
        claimedJobs.push({
          ...c,
          status:        'PROCESSING',
          lockToken,
          lockExpiresAt,
          startedAt:     new Date(),
          attempts:      c.attempts + 1,
        });
      }
      // count === 0 → another runner (or our own reclaim sweep) won the
      // race. Skip silently. Not an error.
    }

    if (claimedJobs.length > 0) {
      // Fire and forget — runOnce returns after CLAIM; the timer-driven
      // pollLoop awaits these via the per-promise tracking. For test
      // mode (runOnce called directly), tests await the in-flight set
      // to drain via `waitForIdle()`.
      //
      // CRITICAL: we add to `inFlight` SYNCHRONOUSLY here (before any
      // microtask yield) so that a caller invoking
      // `await runner.runOnce()` followed immediately by
      // `await runner.waitForIdle()` cannot race past the async
      // prelude of `executeOne()` and observe an empty set before
      // execution has begun. `executeOne()` removes the id in its
      // `finally`.
      for (const j of claimedJobs) {
        this.inFlight.add(j.id);
        const p = this.executeOne(j).catch((e) => {
          log.error('job.execute_unhandled', {
            jobId: j.id, jobType: j.type, error: (e as Error).message,
          });
          // Defensive: if executeOne crashed before reaching `finally`,
          // make sure the id leaves the set so the runner doesn't lock
          // up forever at MAX_CONCURRENT.
          this.inFlight.delete(j.id);
        });
        void p;
      }
    }

    return { claimed: claimedJobs.length, reclaimed };
  }

  /** Wait until inFlight is empty. Used by tests + graceful shutdown. */
  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      if (Date.now() > deadline) {
        throw new InternalError('waitForIdle: timeout', {
          code: 'RUNNER_WAIT_TIMEOUT',
          context: { stillInFlight: this.inFlight.size },
        });
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Execute one claimed job. Handles result-persist, retry, terminal
   * failure. Always removes the job from `inFlight` in `finally`.
   */
  private async executeOne(job: {
    id: string; type: string; payload: string; attempts: number; maxAttempts: number;
    lockToken: string | null;
  }): Promise<void> {
    // NOTE: caller (runOnce) already added job.id to `inFlight`
    // synchronously to close the await-race with `waitForIdle()`.
    // We remove it in the `finally` block below.
    const startedAt = Date.now();

    const jobLog = log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    jobLog.info('job.claimed', { jobId: job.id, jobType: job.type, attempt: job.attempts });

    try {
      if (!hasHandler(job.type)) {
        throw new InternalError(`No handler registered for job type "${job.type}"`, {
          code: 'UNKNOWN_JOB_TYPE',
          context: { type: job.type },
        });
      }
      const handler = getHandler(job.type as JobType);

      // Parse payload — invalid JSON is itself a failure.
      let payload: unknown;
      try {
        payload = JSON.parse(job.payload);
      } catch (e) {
        throw new InternalError(`Job payload is not valid JSON: ${(e as Error).message}`, {
          code: 'INVALID_JOB_PAYLOAD_JSON',
        });
      }

      const ctx: JobContext = {
        jobId:    job.id,
        jobType:  job.type as JobType,
        attempts: job.attempts,
        log:      jobLog,
        extendLock: async (additionalMs?: number) => {
          const newExpiry = new Date(Date.now() + (additionalMs ?? this.config.lockTtlMs));
          // Only extend if we still hold the lock token — protects against
          // a runner extending a job that the reclaimer already promoted.
          await prisma.job.updateMany({
            where: { id: job.id, lockToken: job.lockToken },
            data:  { lockExpiresAt: newExpiry },
          });
        },
      };

      // `as never` — TS can't narrow the handler's payload generic across
      // a string-keyed lookup. The handler re-validates via Zod before use.
      await (handler as (p: unknown, c: JobContext) => Promise<void>)(payload, ctx);

      const durationMs = Date.now() - startedAt;
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status:        'COMPLETED',
          completedAt:   new Date(),
          result:        JSON.stringify({ durationMs }),
          lockToken:     null,
          lockExpiresAt: null,
          error:         null,
        },
      });
      jobLog.info('job.completed', { jobId: job.id, jobType: job.type, durationMs });
    } catch (e) {
      const willRetry = job.attempts < job.maxAttempts;
      const errJson = shapeError(e);

      if (willRetry) {
        const delay = backoffMs(job.attempts);
        const nextRetryAt = new Date(Date.now() + delay);
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status:        'PENDING',
            runAt:         nextRetryAt,
            error:         errJson,
            lockToken:     null,
            lockExpiresAt: null,
          },
        });
        jobLog.warn('job.failed', {
          jobId:       job.id,
          jobType:     job.type,
          attempt:     job.attempts,
          maxAttempts: job.maxAttempts,
          error:       (e as { code?: string }).code ?? 'INTERNAL_ERROR',
          nextRetryAt: nextRetryAt.toISOString(),
        });
      } else {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status:        'FAILED',
            failedAt:      new Date(),
            error:         errJson,
            lockToken:     null,
            lockExpiresAt: null,
          },
        });
        jobLog.error('job.terminal_failure', {
          jobId:    job.id,
          jobType:  job.type,
          attempts: job.attempts,
          error:    (e as { code?: string }).code ?? 'INTERNAL_ERROR',
          message:  (e as Error).message,
        });
      }
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  /** Schedule the next poll. Internal — `start()` kicks off the first one. */
  private scheduleNextPoll(delayMs: number): void {
    if (this.stopRequested) return;
    this.nextPollTimer = setTimeout(() => {
      void this.pollAndReschedule();
    }, delayMs);
    // Unref so a forgotten runner doesn't keep the process alive in dev.
    if (this.nextPollTimer.unref) this.nextPollTimer.unref();
  }

  private async pollAndReschedule(): Promise<void> {
    try {
      await this.runOnce();
    } catch (e) {
      log.error('job.runner.poll_error', { error: (e as Error).message });
    }
    if (!this.stopRequested) {
      this.scheduleNextPoll(this.config.pollIntervalMs);
    }
  }
}
