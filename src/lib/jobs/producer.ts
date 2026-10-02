/**
 * Job producer — the only legitimate way to put work onto the queue.
 *
 * Contract:
 *   - Generic over JobType so the payload shape is compile-time-checked.
 *   - Rejects job types that have no registered handler — fail fast at
 *     enqueue time rather than at runtime (spec §2.4 + §2.7).
 *   - Deduplication: a non-null `deduplicationKey` causes the call to
 *     return the existing PENDING / PROCESSING row instead of creating a
 *     duplicate. The key is embedded in the payload JSON under a special
 *     reserved property so SQLite can match it via a substring search
 *     (no separate dedup table — keeps the schema thin).
 *   - `runAt` in the past is normal: the next runner poll picks up the job.
 *   - `runAt` in the future: the row sits PENDING; the runner ignores
 *     rows whose `runAt > now()`.
 */
import type { Job } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { ValidationError } from '@/lib/errors';
import type { JobType, JobPayload } from '@/lib/jobs/jobTypes';
import { hasHandler } from '@/lib/jobs/workers';

/** Reserved property embedded in the payload JSON to support
 *  string-match dedup without a second table. */
export const DEDUP_KEY_FIELD = '__dedupKey';

export interface EnqueueOptions {
  /** Higher runs sooner. Default 0. */
  priority?:        number;
  /** Earliest pickup time. Default = now (immediate). */
  runAt?:           Date;
  /** Max attempts before terminal FAILED. Default 3. */
  maxAttempts?:     number;
  /** Logical queue. Default 'default'. */
  queueName?:       string;
  /** Parent job id for chains. */
  parentJobId?:     string;
  /** If set, a duplicate (PENDING|PROCESSING) job with the same type+key
   *  is reused instead of creating a new row. */
  deduplicationKey?: string;
}

/**
 * Enqueue a typed background job. The payload is JSON-stringified and
 * stored on the Job row; the worker re-parses + Zod-validates it before use.
 */
export async function enqueueJob<T extends JobType>(
  type: T,
  payload: JobPayload<T>,
  options: EnqueueOptions = {},
): Promise<Job> {
  // Fail-fast: unknown handler → throw at call site, not at execute time.
  if (!hasHandler(type)) {
    throw new ValidationError(`No handler registered for job type "${type}"`, {
      code: 'UNKNOWN_JOB_TYPE',
      context: { type },
    });
  }

  // Embed the dedup key in the payload itself so we can match via a
  // simple `contains` search. The runner workers re-validate payloads
  // with their own Zod schemas (which `.passthrough()` or simply ignore
  // unknown keys), so the extra property is harmless.
  const payloadWithDedup: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (options.deduplicationKey !== undefined) {
    payloadWithDedup[DEDUP_KEY_FIELD] = options.deduplicationKey;
  }
  const payloadJson = JSON.stringify(payloadWithDedup);

  // Dedup check: if a PENDING / PROCESSING row with the same type and
  // dedup key exists, return it.
  if (options.deduplicationKey !== undefined) {
    const dedupNeedle = `"${DEDUP_KEY_FIELD}":${JSON.stringify(options.deduplicationKey)}`;
    const existing = await prisma.job.findFirst({
      where: {
        type,
        status:  { in: ['PENDING', 'PROCESSING'] },
        payload: { contains: dedupNeedle },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      log.debug('job.enqueue_deduplicated', {
        jobId:      existing.id,
        jobType:    type,
        dedupKey:   options.deduplicationKey,
      });
      return existing;
    }
  }

  const job = await prisma.job.create({
    data: {
      type,
      payload:     payloadJson,
      priority:    options.priority    ?? 0,
      runAt:       options.runAt       ?? new Date(),
      maxAttempts: options.maxAttempts ?? 3,
      queueName:   options.queueName   ?? 'default',
      parentJobId: options.parentJobId ?? null,
    },
  });

  log.info('job.enqueued', {
    jobId:     job.id,
    jobType:   job.type,
    runAt:     job.runAt.toISOString(),
    priority:  job.priority,
    queueName: job.queueName,
  });

  return job;
}
