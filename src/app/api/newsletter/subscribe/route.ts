/**
 * POST /api/newsletter/subscribe — Item 18 Phase 2.
 *
 *   Public-facing newsletter capture for the storefront <NewsletterBlock>.
 *   Anonymous-friendly — `getCurrentUser` runs only to enrich the audit
 *   trail (it never gates access).
 *
 * Behaviour (no enumeration leak):
 *
 *   The endpoint returns a UNIFORM 200 `{ received: true }` envelope for
 *   every valid email regardless of whether the address matches a
 *   `User` row. This prevents an attacker from probing the database for
 *   existing accounts via the subscribe form.
 *
 *   Internally:
 *     1. If a User with `email == form.email` exists AND
 *        `emailSubscribed == false`, flip the flag to `true`. (If the
 *        flag is already true, nothing happens — idempotent.)
 *     2. If no User matches, enqueue an admin notification email so
 *        the store operator can decide how to handle the lead. The
 *        existing `notifications.adminEmail` is the recipient — no new
 *        config knob, no new table.
 *
 *   No new Prisma model is added for "anonymous subscribers" — Phase 1
 *   already calls out the future hook; until the store has a real CRM
 *   workflow, the admin-notification path keeps the data flowing
 *   without schema sprawl.
 *
 * Defence-in-depth (matches `/api/contact`):
 *   - CSRF token (double-submit cookie).
 *   - Per-IP rate limit `newsletter.subscribe` (5/hour) — registered in
 *     `rateLimitPolicies.ts`.
 *   - Honeypot field `website` — non-empty value silently returns 200.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { getCurrentUser } from '@/lib/auth/session';
import { getStoreConfig } from '@/lib/storeConfig';
import { prisma } from '@/lib/db/client';
import { enqueueJob } from '@/lib/jobs/producer';
import { JOB_TYPES } from '@/lib/jobs/jobTypes';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

const SubscribeSchema = z.object({
  email:   z.string().trim().email('Please enter a valid email address.').max(254),
  // Honeypot — bots fill every input; humans never see this.
  website: z.string().max(500).optional(),
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await applyRateLimit('newsletter.subscribe', req);

  const raw = await req.json().catch(() => ({} as Record<string, unknown>));
  const parsed = SubscribeSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError('Please enter a valid email address.', 400, {
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const { email, website } = parsed.data;

  // ── Honeypot — silent 200.
  if (website && website.trim().length > 0) {
    log.warn('newsletter.subscribe.honeypot_triggered', {});
    return jsonOk({ received: true });
  }

  const [actor, config] = await Promise.all([getCurrentUser(), getStoreConfig()]);

  // Path 1: matching user → flip emailSubscribed flag (idempotent).
  const lowered = email.toLowerCase();
  const existing = await prisma.user.findFirst({
    where: { email: lowered },
    select: { id: true, emailSubscribed: true },
  });

  if (existing) {
    if (!existing.emailSubscribed) {
      await prisma.user.update({
        where: { id: existing.id },
        data:  { emailSubscribed: true },
      });
      log.info('newsletter.subscribe.user_opted_in', { userId: existing.id });
    } else {
      log.info('newsletter.subscribe.user_already_in', { userId: existing.id });
    }
    return jsonOk({ received: true });
  }

  // Path 2: no matching user → notify the store admin so the operator
  //         can fold this lead into their downstream CRM. We do not
  //         create a User row here — accounts require the full signup
  //         flow (password, KYC, etc).
  const adminEmail = config.notifications.adminEmail;
  if (!adminEmail || adminEmail.trim() === '') {
    log.warn('newsletter.subscribe.admin_email_missing', { actorId: actor?.id ?? null });
    // Still uniform success — never leak the operator's misconfig.
    return jsonOk({ received: true });
  }

  const safeEmail = escapeHtml(lowered);
  const safeStore = escapeHtml(config.store.name);

  await enqueueJob(JOB_TYPES.SEND_EMAIL, {
    to:      adminEmail,
    subject: `[${config.store.name}] New newsletter subscriber: ${lowered}`,
    html:    `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#64748b">${safeStore} newsletter</p>
    <h2 style="margin:0 0 16px;font-size:18px">A new subscriber signed up</h2>
    <p style="margin:0;font-size:14px;line-height:1.55">
      <strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a><br>
      <em>This address is not associated with an existing user account.</em>
    </p>
  </div>
</body></html>`,
    text: `New newsletter subscriber: ${lowered}\nNot associated with an existing account.\n\n-- ${config.store.name}`,
  });

  log.info('newsletter.subscribe.lead_notified', { actorId: actor?.id ?? null });
  return jsonOk({ received: true });
});
