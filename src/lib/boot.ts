/**
 * Boot-time production-safety checks.
 *
 * Called at module-load by every API route through `assertProductionSafe()`.
 * In `production` it throws hard if any of the following are unsafe:
 *   - SESSION_SECRET / CSRF_SECRET are still placeholder values
 *   - admin bootstrap password is still the seed default and that admin
 *     hasn't been replaced (the on-disk default is leaked publicly in seed.ts)
 *   - SMTP not configured (we send real OTPs — silently dropping them is a bug)
 *
 * In `development` it warns once but never blocks.
 *
 * The checks are idempotent — repeated calls are cheap.
 */
import { env } from '@/lib/config';
import { log } from '@/lib/log';

const PLACEHOLDER_SECRETS = new Set([
  'replace_with_64_hex_chars_minimum',
  '',
  'changeme',
  'change-me',
]);

const DEFAULT_BOOTSTRAP_PASSWORD = 'change_me_immediately';

let warned = false;

function looksRandom(secret: string): boolean {
  if (!secret) return false;
  if (PLACEHOLDER_SECRETS.has(secret)) return false;
  if (secret.length < 32) return false;
  // crude entropy heuristic — must contain at least 12 distinct chars
  return new Set(secret).size >= 12;
}

export function checkProductionSafety(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (!looksRandom(env.SESSION_SECRET))
    problems.push('SESSION_SECRET must be set to a strong random value (use: openssl rand -hex 32).');
  if (!looksRandom(env.CSRF_SECRET))
    problems.push('CSRF_SECRET must be set to a strong random value (use: openssl rand -hex 32).');
  if (env.SESSION_SECRET === env.CSRF_SECRET && env.NODE_ENV === 'production')
    problems.push('SESSION_SECRET and CSRF_SECRET must be different values.');

  if (env.NODE_ENV === 'production') {
    if (process.env.SHOPCORE_DISABLE_RATE_LIMITS === '1') {
      // The escape hatch must NEVER be set in production — it disables
      // the global cap + every per-route policy. The test scripts set
      // it explicitly to allow burst patterns; production deployments
      // should never have this var defined.
      problems.push('SHOPCORE_DISABLE_RATE_LIMITS=1 is set — this disables ALL rate limiting and MUST NOT run in production.');
    }
    if (process.env.SHOPCORE_TEST_OTP_FILE) {
      // This env var causes OTP plaintext (signup / login / reset codes)
      // to be appended to a file on disk — used by integration tests
      // for cross-process capture. If left set in production, every
      // OTP issued by the system is durably written to local disk,
      // a catastrophic leak vector. Refuse to start.
      problems.push('SHOPCORE_TEST_OTP_FILE is set — this writes OTP plaintext to disk and MUST NOT run in production.');
    }
    if (process.env.SHOPCORE_ALLOW_TEST_EMAILS === '1') {
      // The test-email allowlist opens up `shopcore.test` and similar
      // pseudo-domains. Production must enforce the real allowlist;
      // this env var bypassing it is a misconfiguration.
      problems.push('SHOPCORE_ALLOW_TEST_EMAILS=1 is set — this opens the email-domain allowlist for tests and MUST NOT run in production.');
    }
    if (!env.SMTP_USER || !env.SMTP_PASS)
      problems.push('SMTP_USER and SMTP_PASS must be configured in production (OTPs/email need a real sender).');
    if (env.BOOTSTRAP_ADMIN_PASSWORD === DEFAULT_BOOTSTRAP_PASSWORD)
      problems.push('BOOTSTRAP_ADMIN_PASSWORD is still the seed default — change it before going live.');
    if (env.APP_URL.startsWith('http://') && !env.APP_URL.includes('localhost'))
      problems.push('APP_URL should be https://… in production.');

    // Firebase Phone Authentication — all three NEXT_PUBLIC_FIREBASE_*
    // vars must be set so the browser SDK can initialise and drive the
    // SMS-OTP / reCAPTCHA flow. The server-side dev-bypass token is
    // unconditionally rejected in production, so absent vars = users
    // are simply unable to verify their phone number = broken signup.
    if (!env.NEXT_PUBLIC_FIREBASE_API_KEY
     || !env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
     || !env.NEXT_PUBLIC_FIREBASE_APP_ID) {
      problems.push(
        'Firebase Phone Auth is not configured. Set NEXT_PUBLIC_FIREBASE_API_KEY, '
        + 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, and NEXT_PUBLIC_FIREBASE_APP_ID in production.',
      );
    }
    // Firebase Admin (already partially-validated downstream) — the
    // server token-verification path needs at least the project id +
    // a service-account credential source. Without these the phone
    // verify route cannot validate the Firebase ID token clients
    // submit, so we surface the gap here as well.
    if (!env.FIREBASE_PROJECT_ID) {
      problems.push('FIREBASE_PROJECT_ID must be set in production (needed to verify Firebase ID tokens).');
    }
    if (!env.FIREBASE_SERVICE_ACCOUNT_JSON && !env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      problems.push('FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH must be set in production.');
    }
  }

  return { ok: problems.length === 0, problems };
}

export function assertProductionSafe(): void {
  const r = checkProductionSafety();
  if (r.ok) return;
  if (env.NODE_ENV === 'production') {
    throw new Error('Production safety check failed:\n  - ' + r.problems.join('\n  - '));
  } else if (!warned) {
    warned = true;
    log.warn('boot.safety_warnings', { problems: r.problems });
  }
}
