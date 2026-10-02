/**
 * Nodemailer over Gmail SMTP (free, ≤500/day — fits scale).
 *
 * Behaviour:
 *  - If SMTP_USER + SMTP_PASS are configured → real send.
 *  - If NOT configured + NODE_ENV=development → log the OTP/email to server console
 *    with a loud banner. This is the ONLY "dev convenience"; it never serves a
 *    mocked OTP to the client, the code is still real and stored hashed.
 *  - If NOT configured + NODE_ENV=production → throw. Never silently swallow.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { appendFileSync } from 'node:fs';
import { env } from '@/lib/config';
import { log } from '@/lib/log';
import { ExternalServiceError, wrapExternal } from '@/lib/errors';

let _transporter: Transporter | null = null;

/**
 * Test hook. NEVER set this in production code paths — it is only invoked from
 * `scripts/test-auth.ts`. When set, OTP codes are recorded here instead of
 * (or in addition to) being sent.
 */
export const _otpCaptureForTests: { items: { email: string; code: string; purpose: string }[] } = { items: [] };
export function _enableOtpCaptureForTests() { (globalThis as Record<string, unknown>).__SC_CAPTURE_OTP__ = true; }

/**
 * Cross-process OTP capture. When SHOPCORE_TEST_OTP_FILE is set, every OTP
 * email triggered inside this process is also appended (as JSON-line) to
 * that file path. Used by integration tests that spawn `next start` in a
 * child process — the in-memory `_otpCaptureForTests` is unreachable from
 * the test runner, but the file is.
 *
 * Format: one JSON object per line: { email, code, purpose, ts }
 * Never enabled in production code paths; the test sets the env var.
 */

function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;

  _transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return _transporter;
}

async function send(to: string, subject: string, html: string, text: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    if (env.NODE_ENV === 'production') {
      throw new ExternalServiceError(
        'SMTP not configured. Set SMTP_USER and SMTP_PASS in .env.',
        { code: 'SMTP_NOT_CONFIGURED',
          clientMessage: 'Email service is temporarily unavailable. Please try again shortly.' },
      );
    }
    // SMTP not configured + dev mode: emit a structured log line so:
    //   (a) integration tests can grep the server log file for the OTP
    //       digits as a fallback to the SHOPCORE_TEST_OTP_FILE channel
    //       (the body contains the 6-digit code verbatim).
    //   (b) a human running `npm run dev` still sees the OTP in their
    //       terminal — just as JSON instead of a banner.
    //
    // `email` is auto-masked by the redactor; `body` is intentionally
    // not masked because it IS the test artefact and only fires
    // outside production (the `NODE_ENV === 'production'` branch above
    // throws before we get here).
    log.info('email.dev_fallback', {
      email: to,
      subject,
      body: text,
    });
    return;
  }
  // Wrap the SMTP call: nodemailer rejects with provider-specific Error
  // shapes (e.g. `EAUTH`, `ETIMEDOUT`). We route every failure through
  // ExternalServiceError so the route handler gets a 502 + safe client
  // message rather than a leaked SMTP server response.
  await wrapExternal('smtp', 'sendMail', async () => {
    await t.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  }, {
    code: 'SMTP_SEND_FAILED',
    clientMessage: 'We could not send your email. Please try again shortly.',
  });
}

export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: string,
  expiryMinutes: number,
): Promise<void> {
  if ((globalThis as Record<string, unknown>).__SC_CAPTURE_OTP__) {
    _otpCaptureForTests.items.push({ email: to, code, purpose });
    return;
  }
  // Cross-process capture for integration tests that read OTPs from a file.
  // Strictly NEVER active unless SHOPCORE_TEST_OTP_FILE is set in the env.
  const otpFile = process.env.SHOPCORE_TEST_OTP_FILE;
  if (otpFile) {
    try {
      appendFileSync(otpFile, JSON.stringify({ email: to, code, purpose, ts: Date.now() }) + '\n');
    } catch { /* never fail the email send because of a test side-channel */ }
    // fall through so dev-console banner still prints for visibility
  }
  const subject =
    purpose === 'SIGNUP' ? `${env.APP_NAME}: Verify your email`
    : purpose === 'LOGIN' ? `${env.APP_NAME}: Your login code`
    : purpose === 'RESET' ? `${env.APP_NAME}: Password reset code`
    : `${env.APP_NAME}: Your verification code`;

  const text =
    `Your ${env.APP_NAME} verification code is:\n\n` +
    `    ${code}\n\n` +
    `This code expires in ${expiryMinutes} minutes.\n` +
    `If you did not request this, you can safely ignore this email.\n`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px">
    <h2 style="margin:0 0 16px;font-size:20px">${env.APP_NAME} verification</h2>
    <p style="margin:0 0 24px;color:#475569">Use the code below to continue:</p>
    <div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#f1f5f9;border-radius:8px;padding:18px;text-align:center">${code}</div>
    <p style="margin:24px 0 0;color:#64748b;font-size:13px">This code expires in ${expiryMinutes} minutes. If you did not request it, ignore this email.</p>
  </div>
</body></html>`;

  await send(to, subject, html, text);
}

export async function sendGenericEmail(to: string, subject: string, html: string, text?: string) {
  await send(to, subject, html, text ?? html.replace(/<[^>]+>/g, ''));
}
