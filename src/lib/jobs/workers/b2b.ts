/**
 * B2B_QUOTE_EXPIRY worker — spec §2.7.
 *
 * Mark any OPEN QuoteRequest older than 7 days as EXPIRED. The B2B portal's
 * customer view shows the EXPIRED state so the buyer knows they need to
 * re-submit.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/errors';
import type { JobContext, JobHandler } from '@/lib/jobs/workers';
import type { B2BQuoteExpiryPayload } from '@/lib/jobs/jobTypes';

const PayloadSchema = z.object({
  quoteId: z.string().min(1).optional(),
});

const EXPIRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const b2bQuoteExpiryHandler: JobHandler<B2BQuoteExpiryPayload> = async (
  payload,
  ctx: JobContext,
) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Invalid B2B_QUOTE_EXPIRY payload', { code: 'INVALID_JOB_PAYLOAD' });
  }
  const { quoteId } = parsed.data;
  const cutoff = new Date(Date.now() - EXPIRY_AGE_MS);

  const updated = await prisma.quoteRequest.updateMany({
    where: {
      ...(quoteId ? { id: quoteId } : {}),
      status:    'OPEN',
      createdAt: { lt: cutoff },
    },
    data: { status: 'EXPIRED' },
  });

  ctx.log.info('job.b2b_quote_expiry.done', { expired: updated.count });
};
