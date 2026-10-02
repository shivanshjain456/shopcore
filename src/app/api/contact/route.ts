/**
 * POST /api/contact — Item 13.
 *
 * Public-facing contact form endpoint. Anonymous-friendly: getCurrentUser()
 * runs only to enrich the submission (subject prefix, optional support
 * ticket creation for the authenticated path) — it never gates access.
 *
 * Spam controls (defence-in-depth):
 *   1. CSRF token (the standard double-submit pattern; assertCsrf throws
 *      403 before we touch the body).
 *   2. Per-IP rate limit `contact.form` — 3/hr (see rateLimitPolicies.ts).
 *   3. Honeypot field `website` — bots fill every input; humans never see
 *      this. A non-empty value silently returns 200 (the bot can't tell
 *      its submission was discarded, so it stops trying alternative
 *      payloads).
 *
 * On success:
 *   - Enqueue a SEND_EMAIL background job to `notifications.adminEmail`
 *     (Item 7 — never send synchronously from a request handler).
 *   - If the user is authenticated, also create a SupportTicket so the
 *     conversation lives in the admin ticket queue. The subject is
 *     prefixed `[CONTACT_FORM]` so admins can filter — the existing
 *     schema has no `source` column and the spec is explicit about
 *     NOT adding a migration unless genuinely needed.
 *
 * Email-pinning rule (spec §3.8):
 *   - Anonymous: `from` is the system address; the submitter's email is
 *     surfaced inside the body as "Reply to: …" so the admin can copy/
 *     paste back. (SendEmailPayload doesn't carry replyTo today; adding
 *     it is an Item 7 schema change.)
 *   - Authenticated: we override the form's `email` value with the
 *     session email — an authed user can NEVER make a contact-form
 *     submission appear to come from another address.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { getCurrentUser } from '@/lib/auth/session';
import { getStoreConfig } from '@/lib/storeConfig';
import { prisma } from '@/lib/db/client';
import { enqueueJob } from '@/lib/jobs/producer';
import { JOB_TYPES } from '@/lib/jobs/jobTypes';
import { log } from '@/lib/log';
import { ContactFormSchema } from '@/lib/contact/schema';

export const dynamic = 'force-dynamic';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildContactEmailHtml(args: {
  name:     string;
  email:    string;      // already-resolved (session email for authed, form email for anon)
  subject:  string;
  message:  string;
  storeName: string;
  userId?:  string | null;
  ticketId?: string | null;
}): string {
  const meta = [
    `<strong>From:</strong> ${escapeHtml(args.name)} &lt;${escapeHtml(args.email)}&gt;`,
    args.userId  ? `<strong>User ID:</strong> <code>${escapeHtml(args.userId)}</code>` : null,
    args.ticketId ? `<strong>Ticket:</strong> <code>${escapeHtml(args.ticketId)}</code>` : null,
    `<strong>Reply-to:</strong> <a href="mailto:${escapeHtml(args.email)}">${escapeHtml(args.email)}</a>`,
  ].filter(Boolean).join('<br>');

  // Preserve newlines in the message as <br>.
  const body = escapeHtml(args.message).replace(/\n/g, '<br>');

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#64748b">${escapeHtml(args.storeName)} contact form</p>
    <h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(args.subject)}</h2>
    <div style="margin:0 0 16px;padding:12px;border-radius:8px;background:#f8fafc;font-size:13px;color:#475569">${meta}</div>
    <div style="margin:0;padding:0;font-size:14px;line-height:1.55">${body}</div>
  </div>
</body></html>`;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await applyRateLimit('contact.form', req);

  const raw = await req.json().catch(() => ({} as Record<string, unknown>));
  const parsed = ContactFormSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError('Please check the form and try again.', 400, {
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const body = parsed.data;

  // ── Honeypot — silent 200. Per spec §3.8 we deliberately return the
  //    same shape as a real success so the bot has no signal to retry.
  if (body.website && body.website.trim().length > 0) {
    // Hash + truncate the IP for the log line (the structured logger
    // doesn't redact a literal `ip` field — keep it short).
    log.warn('contact.form.honeypot_triggered', {});
    return jsonOk({ received: true });
  }

  const [user, config] = await Promise.all([getCurrentUser(), getStoreConfig()]);

  // Authenticated email-pinning: a logged-in user CANNOT make the form
  // appear to come from a different address.
  const resolvedEmail = user ? user.email : body.email;
  const resolvedName  = user ? `${user.firstName} ${user.lastName}`.trim() || body.name : body.name;

  const adminEmail = config.notifications.adminEmail;
  if (!adminEmail || adminEmail.trim() === '') {
    log.warn('contact.form.admin_email_missing', { userId: user?.id ?? null });
    // 503 — the page renders fine, only the submission failed.
    return jsonError(
      'The contact form is temporarily unavailable. Please email us directly using the address shown on the page.',
      503,
      { code: 'CONTACT_FORM_UNAVAILABLE' },
    );
  }

  // ── Optional: create a SupportTicket for authenticated callers so
  //    the admin can track the conversation in the ticket queue. We
  //    prefix the subject with `[CONTACT_FORM]` so admins can filter —
  //    the SupportTicket schema has no `source` column today.
  let ticketId: string | null = null;
  if (user) {
    try {
      const ticket = await prisma.supportTicket.create({
        data: {
          userId:   user.id,
          subject:  `[CONTACT_FORM] ${body.subject}`,
          category: 'OTHER',
          status:   'OPEN',
          priority: 'NORMAL',
          messages: {
            create: {
              authorId: user.id,
              body:     body.message,
            },
          },
        },
      });
      ticketId = ticket.id;
      log.info('support.ticket.created_from_contact', { userId: user.id, ticketId });
    } catch (e) {
      // Don't block the email enqueue on a ticket-create failure.
      log.warn('contact.form.ticket_create_failed', {
        userId: user.id,
        error:  (e as Error).message,
      });
    }
  }

  await enqueueJob(JOB_TYPES.SEND_EMAIL, {
    to:      adminEmail,
    subject: `[${config.store.name} Contact] ${body.subject}`,
    html:    buildContactEmailHtml({
      name:      resolvedName,
      email:     resolvedEmail,
      subject:   body.subject,
      message:   body.message,
      storeName: config.store.name,
      userId:    user?.id ?? null,
      ticketId,
    }),
    text: `From: ${resolvedName} <${resolvedEmail}>\n\n${body.message}\n\n-- ${config.store.name}`,
  });

  log.info('contact.form.submitted', {
    userId:  user?.id ?? null,
    subject: body.subject,
    ticketId,
  });

  return jsonOk({ received: true, ticketId });
});
