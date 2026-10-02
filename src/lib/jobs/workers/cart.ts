/**
 * ABANDONED_CART_REMINDER worker — spec §2.7 + §3.8.
 *
 * Scope: find carts that are "actively stale" (updated 2–24h ago) belonging
 * to ACTIVE + email-subscribed users who do NOT have a recent order, and
 * enqueue one SEND_EMAIL job per user. Idempotent by 24h cooldown (we
 * record a UserActivity `ABANDONED_CART_REMINDER_SENT` row).
 */
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/errors';
import { enqueueJob } from '@/lib/jobs/producer';
import { JOB_TYPES, type AbandonedCartReminderPayload } from '@/lib/jobs/jobTypes';
import type { JobContext, JobHandler } from '@/lib/jobs/workers';
import { env } from '@/lib/config';

const PayloadSchema = z.object({
  cartId: z.string().min(1).optional(),
});

// Reminders we won't repeat within this window per user.
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Cart staleness window (must have been touched 2h+ ago, but not >24h —
// older carts are considered cold and not worth re-engaging).
const STALE_MIN_MS = 2  * 60 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

// Hard cap on the number of carts we'll process per single tick. Stops a
// worker explosion if the catalog launches with thousands of stale carts.
const BATCH_LIMIT = 200;

export const abandonedCartReminderHandler: JobHandler<AbandonedCartReminderPayload> = async (
  payload,
  ctx: JobContext,
) => {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Invalid ABANDONED_CART_REMINDER payload', { code: 'INVALID_JOB_PAYLOAD' });
  }
  const { cartId } = parsed.data;

  const now      = Date.now();
  const staleHi  = new Date(now - STALE_MIN_MS);   // updatedAt < this (older than 2h)
  const staleLo  = new Date(now - STALE_MAX_MS);   // updatedAt > this (younger than 24h)
  const cooldown = new Date(now - COOLDOWN_MS);

  // Look up candidate carts. Paginated by `take` to bound memory (spec §5.3).
  const carts = await prisma.cart.findMany({
    where: {
      ...(cartId ? { id: cartId } : {}),
      updatedAt: { lt: staleHi, gt: staleLo },
      items:     { some: {} },                      // not empty
      user: {
        status:          'ACTIVE',
        emailSubscribed: true,
      },
    },
    select: {
      id:        true,
      userId:    true,
      user:      { select: { email: true, firstName: true } },
      _count:    { select: { items: true } },
    },
    take: BATCH_LIMIT,
  });

  let enqueued = 0;
  let skippedRecentOrder = 0;
  let skippedRecentReminder = 0;

  for (const cart of carts) {
    // Skip if the user placed an order in the cooldown window
    const recentOrder = await prisma.order.findFirst({
      where: { userId: cart.userId, createdAt: { gt: cooldown } },
      select: { id: true },
    });
    if (recentOrder) { skippedRecentOrder++; continue; }

    // Skip if we already sent a reminder in the cooldown window
    const recentReminder = await prisma.userActivity.findFirst({
      where: {
        userId:    cart.userId,
        action:    'ABANDONED_CART_REMINDER_SENT',
        createdAt: { gt: cooldown },
      },
      select: { id: true },
    });
    if (recentReminder) { skippedRecentReminder++; continue; }

    const text =
      `Hi ${cart.user.firstName ?? 'there'},\n\n` +
      `You left ${cart._count?.items ?? 'some'} item(s) in your ${env.APP_NAME} cart.\n` +
      `Come back to complete your purchase: ${env.APP_URL}/cart\n\n` +
      `— The ${env.APP_NAME} team\n`;
    const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;padding:24px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px">
        <h2 style="margin:0 0 12px;font-size:20px">You left something behind</h2>
        <p style="color:#475569;margin:0 0 16px">Hi ${cart.user.firstName ?? 'there'}, your cart at ${env.APP_NAME} still has items waiting.</p>
        <p style="margin:24px 0"><a href="${env.APP_URL}/cart" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">View your cart</a></p>
        <p style="color:#64748b;font-size:13px">You're receiving this because you have an active ${env.APP_NAME} account. You can disable these reminders from your account settings.</p>
      </div></body></html>`;

    // Enqueue — one SEND_EMAIL job per user so a single SMTP failure does
    // not block siblings (spec §3.8).
    await enqueueJob(JOB_TYPES.SEND_EMAIL, {
      to:      cart.user.email,
      subject: `Your ${env.APP_NAME} cart is waiting`,
      html,
      text,
    }, {
      deduplicationKey: `abandoned_cart:${cart.userId}:${cart.id}`,
    });

    // Record the reminder so we don't re-send within COOLDOWN_MS.
    await prisma.userActivity.create({
      data: {
        userId:   cart.userId,
        action:   'ABANDONED_CART_REMINDER_SENT',
        metadata: JSON.stringify({ cartId: cart.id }),
      },
    });

    enqueued++;
  }

  ctx.log.info('job.abandoned_cart_reminder.done', {
    candidates: carts.length,
    enqueued,
    skippedRecentOrder,
    skippedRecentReminder,
  });
};
