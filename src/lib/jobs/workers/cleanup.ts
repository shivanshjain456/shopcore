/**
 * Cleanup workers: OTPs, sessions, reset tokens, idempotency keys.
 *
 * Each handler runs against the production Prisma client and returns void.
 * Workers MUST log the row counts they deleted/updated — the admin
 * dashboard surfaces these via `job.result` parsed JSON.
 */
import { prisma } from '@/lib/db/client';
import type { JobContext, JobHandler } from '@/lib/jobs/workers';
import type { EmptyPayload } from '@/lib/jobs/jobTypes';

/**
 * CLEANUP_EXPIRED_OTPS — spec §2.7.
 *
 * Deletion policy:
 *   (a) Any consumed OTP (`consumedAt IS NOT NULL`) past its expiry —
 *       no value in keeping a single-use code after expiry.
 *   (b) Any OTP whose `expiresAt` is older than 24h — sweeps stale rows
 *       even if they were never explicitly consumed (e.g. user abandoned
 *       the flow).
 */
export const cleanupExpiredOtpsHandler: JobHandler<EmptyPayload> = async (_payload, ctx: JobContext) => {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const consumed = await prisma.otpCode.deleteMany({
    where: { expiresAt: { lt: now }, consumedAt: { not: null } },
  });
  const stale = await prisma.otpCode.deleteMany({
    where: { expiresAt: { lt: oneDayAgo } },
  });

  ctx.log.info('job.cleanup_expired_otps.done', {
    consumedDeleted: consumed.count,
    staleDeleted:    stale.count,
    totalDeleted:    consumed.count + stale.count,
  });
};

/**
 * CLEANUP_EXPIRED_SESSIONS — spec §2.7.
 *
 *   Session         — delete rows where expiresAt < now
 *   RefreshToken    — delete rows belonging to a RefreshTokenFamily whose
 *                     absoluteExpiresAt has passed (the family will be
 *                     cascaded too; we delete the family last so the
 *                     RefreshToken FK doesn't refuse)
 *
 * Note: `pruneExpiredRefreshFamilies()` in `lib/auth/refresh.ts` already
 * implements the family-side prune (kept for the legacy backup script).
 * We reuse it here for the token side rather than re-deriving the logic.
 */
export const cleanupExpiredSessionsHandler: JobHandler<EmptyPayload> = async (_payload, ctx: JobContext) => {
  const now = new Date();

  const sessions = await prisma.session.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  // Reuse the canonical family-prune from lib/auth/refresh — keeps the
  // deletion criteria (>7d past absoluteExpiresAt) in one place.
  const { pruneExpiredRefreshFamilies } = await import('@/lib/auth/refresh');
  const familiesRemoved = await pruneExpiredRefreshFamilies(now);

  ctx.log.info('job.cleanup_expired_sessions.done', {
    sessionsDeleted:  sessions.count,
    familiesRemoved,
  });
};

/**
 * CLEANUP_EXPIRED_RESET_TOKENS — spec §2.7.
 *
 *   PasswordResetToken    — delete where expiresAt < now
 *   PasswordResetRequest  — flip status to EXPIRED for any PENDING row
 *                           whose expiresAt has passed
 */
export const cleanupExpiredResetTokensHandler: JobHandler<EmptyPayload> = async (_payload, ctx: JobContext) => {
  const now = new Date();

  const tokens = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  const requests = await prisma.passwordResetRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data:  { status: 'EXPIRED' },
  });

  ctx.log.info('job.cleanup_expired_reset_tokens.done', {
    tokensDeleted:    tokens.count,
    requestsExpired:  requests.count,
  });
};

/**
 * CLEANUP_STUCK_IDEMPOTENCY — spec §2.7. This worker REPLACES the previous
 * inline cleanup in the checkout flow.
 *
 * Promotes any IdempotencyKey row stuck in PROCESSING for >5 minutes to
 * FAILED. A row stuck in PROCESSING means the original handler crashed
 * before it could write the success body; subsequent requests with the
 * same key should fail fast (and clients can retry with a fresh key).
 */
export const cleanupStuckIdempotencyHandler: JobHandler<EmptyPayload> = async (_payload, ctx: JobContext) => {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);

  const updated = await prisma.idempotencyKey.updateMany({
    where: { status: 'PROCESSING', createdAt: { lt: cutoff } },
    data:  { status: 'FAILED' },
  });

  // Prune anything past expiry as well — same job, two related sweeps.
  const { pruneExpiredIdempotencyKeys } = await import('@/lib/checkout/idempotency');
  const pruned = await pruneExpiredIdempotencyKeys(new Date());

  ctx.log.info('job.cleanup_stuck_idempotency.done', {
    stuckPromoted: updated.count,
    expiredPruned: pruned,
  });
};
