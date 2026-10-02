/**
 * Worker registry — maps every JobType to its handler. The runner looks
 * up handlers from here at execute time; the producer looks up handlers
 * at enqueue time so that "no handler" surfaces as a synchronous error
 * at the call site rather than as a delayed runtime failure.
 *
 * Discipline:
 *   - One handler per JobType. Period.
 *   - Every handler must use `ctx.log` (the pre-bound child logger) for
 *     every log line — not the root `log`. This guarantees `jobId` +
 *     `jobType` appear in every log line traceable to a worker.
 *   - Handlers throw `ShopCoreError` subclasses for typed failures. The
 *     runner translates anything else to InternalError before persisting
 *     `job.error`.
 *   - A handler that catches an exception and returns normally is
 *     considered a SUCCESS — no silent swallows.
 *
 * Stub handlers (future job types whose business logic is owned by a
 * later sprint) log `job.handler_not_implemented` at warn level and
 * complete successfully so an early enqueue (e.g. a coupon admin saving
 * a future-dated promotion) doesn't cause runtime crashes.
 */
import type { Logger } from '@/lib/log';
import { JOB_TYPES, type JobType, type JobPayloadMap } from '@/lib/jobs/jobTypes';

import { sendEmailHandler } from '@/lib/jobs/workers/email';
import {
  cleanupExpiredOtpsHandler,
  cleanupExpiredSessionsHandler,
  cleanupExpiredResetTokensHandler,
  cleanupStuckIdempotencyHandler,
} from '@/lib/jobs/workers/cleanup';
import { abandonedCartReminderHandler } from '@/lib/jobs/workers/cart';
import { lowStockAlertHandler } from '@/lib/jobs/workers/inventory';
import { b2bQuoteExpiryHandler } from '@/lib/jobs/workers/b2b';
import {
  dbVacuumHandler,
  dbBackupHandler,
  auditLogArchiveHandler,
} from '@/lib/jobs/workers/maintenance';

export interface JobContext {
  jobId:    string;
  jobType:  JobType;
  attempts: number;
  /** Pre-bound child logger: every line carries `{ jobId, jobType, attempt }`. */
  log:      Logger;
  /** Extend the in-DB lock TTL — long-running jobs MUST call this periodically
   *  (heartbeat pattern) so the runner's stale-lock reclaimer does not
   *  promote them back to PENDING mid-execution. Spec §3.7. */
  extendLock: (additionalMs?: number) => Promise<void>;
}

export type JobHandler<T> = (payload: T, ctx: JobContext) => Promise<void>;

/**
 * Stub factory — returns a handler that logs a warning and completes. Used
 * for JobTypes registered in `jobTypes.ts` whose business logic will land
 * in a future sprint. Spec §2.3.
 */
function stubHandler<T>(): JobHandler<T> {
  return async (_payload, ctx) => {
    ctx.log.warn('job.handler_not_implemented', { jobType: ctx.jobType });
  };
}

/**
 * The registry. Typed so a missing JobType causes a compile error
 * (`Property '...' is missing in type ...`).
 */
type HandlerMap = { [T in JobType]: JobHandler<JobPayloadMap[T]> };

export const handlers: HandlerMap = {
  [JOB_TYPES.SEND_EMAIL]:                   sendEmailHandler,
  [JOB_TYPES.CLEANUP_EXPIRED_OTPS]:         cleanupExpiredOtpsHandler,
  [JOB_TYPES.CLEANUP_EXPIRED_SESSIONS]:     cleanupExpiredSessionsHandler,
  [JOB_TYPES.CLEANUP_EXPIRED_RESET_TOKENS]: cleanupExpiredResetTokensHandler,
  [JOB_TYPES.CLEANUP_STUCK_IDEMPOTENCY]:    cleanupStuckIdempotencyHandler,
  [JOB_TYPES.ABANDONED_CART_REMINDER]:      abandonedCartReminderHandler,
  [JOB_TYPES.LOW_STOCK_ALERT]:              lowStockAlertHandler,
  [JOB_TYPES.B2B_QUOTE_EXPIRY]:             b2bQuoteExpiryHandler,
  [JOB_TYPES.DB_VACUUM]:                    dbVacuumHandler,
  [JOB_TYPES.DB_BACKUP]:                    dbBackupHandler,
  [JOB_TYPES.AUDIT_LOG_ARCHIVE]:            auditLogArchiveHandler,
  // Stubs — registered to satisfy the "every type has a handler" invariant.
  [JOB_TYPES.ACCOUNT_DELETION_CLEANUP]:     stubHandler(),
  [JOB_TYPES.RESTOCK_NOTIFICATION]:         stubHandler(),
  [JOB_TYPES.ORDER_STATUS_NOTIFICATION]:    stubHandler(),
  [JOB_TYPES.PROMOTION_ACTIVATION]:         stubHandler(),
  [JOB_TYPES.PROMOTION_EXPIRY]:             stubHandler(),
  [JOB_TYPES.SITEMAP_GENERATION]:           stubHandler(),
  [JOB_TYPES.ANALYTICS_DAILY_ROLLUP]:       stubHandler(),
};

export function hasHandler(type: string): type is JobType {
  return Object.prototype.hasOwnProperty.call(handlers, type);
}

export function getHandler<T extends JobType>(type: T): JobHandler<JobPayloadMap[T]> {
  return handlers[type];
}
