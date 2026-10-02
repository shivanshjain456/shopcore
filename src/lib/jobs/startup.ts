/**
 * Job system startup — wires the runner + scheduler to the Node process.
 *
 * Called from `src/lib/db/client.ts` via a guarded dynamic import so the
 * test harness (which sets NODE_ENV=test) never starts the runner. Spec
 * §2.8 + §3.6.
 *
 * Singleton: a module-level flag prevents double-start under Next.js hot
 * reload or React Strict Mode.
 */
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { env } from '@/lib/config';
import { JobRunner } from '@/lib/jobs/runner';
import { JobScheduler, seedJobSchedules } from '@/lib/jobs/scheduler';

let _runner:    JobRunner    | null = null;
let _scheduler: JobScheduler | null = null;
let _started = false;
let _shutdownRegistered = false;

/** Test/instrumentation only — never call from production code. */
export function _resetForTests(): void {
  _runner = null;
  _scheduler = null;
  _started = false;
  _shutdownRegistered = false;
}

export function getRunner():    JobRunner    | null { return _runner; }
export function getScheduler(): JobScheduler | null { return _scheduler; }

/**
 * Start the runner + scheduler. Idempotent.
 *
 * Guards:
 *   - `NODE_ENV=test`               → never starts
 *   - `JOB_RUNNER_ENABLED=false`    → never starts (e.g. read-only replica)
 *   - Job table missing             → logs an actionable error and returns
 *                                      without crashing the host process
 */
export function startJobRunner(): void {
  if (_started) return;
  if (env.NODE_ENV === 'test') {
    log.debug('job.runner.skip_in_test', {});
    return;
  }
  if (!env.JOB_RUNNER_ENABLED) {
    log.info('job.runner.disabled_by_env', {});
    return;
  }

  // Verify the Job table exists before starting the timers. If the
  // migration wasn't applied, surface a clear actionable error rather
  // than letting `findMany` throw mid-poll. Spec §3.11.
  void prisma.job.count()
    .then(async () => {
      // Seed built-in schedules on every startup (idempotent upsert).
      try {
        const res = await seedJobSchedules();
        log.info('job.schedules.seeded', res);
      } catch (e) {
        log.error('job.schedules.seed_failed', { error: (e as Error).message });
      }

      _runner    = new JobRunner();
      _scheduler = new JobScheduler();
      _runner.start();
      _scheduler.start();
      _started = true;

      if (!_shutdownRegistered) {
        const shutdown = (signal: string): void => {
          log.info('job.shutdown.signal', { signal });
          void (async () => {
            try {
              if (_scheduler) await _scheduler.stop();
              if (_runner)    await _runner.stop();
            } catch (e) {
              log.error('job.shutdown.error', { error: (e as Error).message });
            }
          })();
        };
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        process.once('SIGINT',  () => shutdown('SIGINT'));
        _shutdownRegistered = true;
      }
    })
    .catch((e: Error) => {
      log.error('job.runner.start_failed', {
        error: e.message,
        hint:  'Job table not found? Run `npx prisma migrate deploy`.',
      });
    });
}
