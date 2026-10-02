/**
 * SEND_EMAIL worker. Spec §2.7.
 *
 * The job system never sends mail directly — every other worker (low-stock,
 * abandoned-cart, etc.) ENQUEUES a SEND_EMAIL job per recipient and lets
 * this handler do the actual SMTP work. Why:
 *   - Each per-recipient send is one job → one failure does not block siblings
 *   - SMTP transient failures get the runner's exponential backoff retry
 *   - The send-email payload is small + uniform, easy to introspect in the
 *     admin dashboard
 */
import { z } from 'zod';
import { sendGenericEmail } from '@/lib/email/send';
import { ValidationError } from '@/lib/errors';
import type { JobContext, JobHandler } from '@/lib/jobs/workers';
import type { SendEmailPayload } from '@/lib/jobs/jobTypes';

const SendEmailPayloadSchema = z.object({
  to:      z.string().email(),
  subject: z.string().min(1).max(998),     // RFC 5322 line-length cap
  html:    z.string().min(1),
  text:    z.string().optional(),
});

function maskEmail(addr: string): string {
  // Logger redactor masks `email` field names automatically, but we mask
  // here too because the job payload pushes it under arbitrary keys in
  // worker log lines.
  const at = addr.indexOf('@');
  if (at <= 0) return '***';
  const user = addr.slice(0, at);
  const host = addr.slice(at + 1);
  const masked = user.length <= 2 ? '*'.repeat(user.length) : user[0] + '***' + user[user.length - 1];
  return `${masked}@${host}`;
}

export const sendEmailHandler: JobHandler<SendEmailPayload> = async (payload, ctx: JobContext) => {
  // Re-validate at execute time — the producer's compile-time check does
  // not survive enqueue → dequeue (payload was JSON-roundtripped).
  const parsed = SendEmailPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid SEND_EMAIL payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      { code: 'INVALID_JOB_PAYLOAD' },
    );
  }
  const { to, subject, html, text } = parsed.data;

  ctx.log.info('job.send_email.start', { to: maskEmail(to), subject });

  // sendGenericEmail throws ExternalServiceError on SMTP failure — the
  // runner catches it and re-queues with backoff (spec §3.5).
  await sendGenericEmail(to, subject, html, text);

  ctx.log.info('job.send_email.success', { to: maskEmail(to) });
};
