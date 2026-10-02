/**
 * Centralised, type-safe access to environment variables.
 * Fail fast at startup if anything required is missing.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME: z.string().default('ShopCore'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),

  // Firebase — optional at boot so dev can scaffold without it, enforced when used
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),

  // Firebase JS SDK — used CLIENT-SIDE by `src/lib/client/firebase.ts`
  // to initialise the browser SDK that drives Phone Authentication
  // (reCAPTCHA + SMS-OTP). These vars are embedded at BUILD time by
  // Next.js (prefix `NEXT_PUBLIC_`). In dev they may be absent — the
  // PhoneVerificationForm falls back to a dev-bypass UI. In production
  // `scripts/preflight.ts` hard-fails if any of the three is missing.
  NEXT_PUBLIC_FIREBASE_API_KEY:     z.string().optional(),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_APP_ID:      z.string().optional(),

  // SMTP
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z.coerce.boolean().default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('ShopCore <noreply@example.com>'),

  // OTP
  OTP_LENGTH: z.coerce.number().min(4).max(10).default(6),
  OTP_EXPIRY_MINUTES: z.coerce.number().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(60),

  // Bootstrap admin
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_FIRSTNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_LASTNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PHONE: z.string().optional(),

  // Payment
  PAYMENT_UPI_ID: z.string().default(''),
  PAYMENT_DISPLAY_NAME: z.string().default('Store'),

  // Uploads
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(5),

  // NOTE: Rate-limit numbers used to live here as individual env vars
  // (`RATE_LIMIT_LOGIN_PER_15MIN`, `RATE_LIMIT_OTP_PER_HOUR`,
  // `RATE_LIMIT_GLOBAL_PER_MIN`). They were removed when the unified
  // rate-limit policy registry shipped — see
  // `src/lib/security/rateLimitPolicies.ts`. Rate-limit policy is now
  // operational code: changing a limit requires a deployment, not an
  // env-var flip in a running system. Any value left in old `.env`
  // files is silently ignored.

  // ── Background Jobs (Item 7) ────────────────────────────────────────
  // Tunables for the SQLite-backed job runner + scheduler. All have
  // sensible defaults — leave unset in normal deployments. See
  // src/lib/jobs/runner.ts and src/lib/jobs/scheduler.ts.
  JOB_RUNNER_ENABLED:             z.coerce.boolean().default(true),
  JOB_RUNNER_POLL_INTERVAL_MS:    z.coerce.number().int().positive().default(5_000),
  JOB_RUNNER_BATCH_SIZE:          z.coerce.number().int().positive().default(5),
  JOB_RUNNER_MAX_CONCURRENT:      z.coerce.number().int().positive().default(10),
  JOB_RUNNER_LOCK_TTL_MS:         z.coerce.number().int().positive().default(5 * 60 * 1000),     // 5 min
  JOB_RUNNER_DRAIN_TIMEOUT_MS:    z.coerce.number().int().positive().default(30 * 1000),         // 30 s
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // We deliberately use process.stderr.write here (not the logger):
  // config.ts is imported by log.ts (transitively, via dependency
  // graph), so calling `log.error` from this file would risk a
  // partially-initialised module. This is the SINGLE legitimate
  // process.stderr usage outside log.ts and the static audit
  // recognises it explicitly.
  process.stderr.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'config.invalid_env',
    fieldErrors: parsed.error.flatten().fieldErrors,
    env: process.env.NODE_ENV,
    pid: process.pid,
  }) + '\n');
  throw new Error('Invalid environment. Check .env against .env.example.');
}

export const env = parsed.data;

/**
 * Admin-editable store policy. **Moved** to `src/lib/storeConfig/defaults.ts`
 * as part of Item 8 (Admin Power Features). We re-export from here for
 * backwards compatibility with the 10+ existing importers — no caller
 * needs to change. New code should import directly from
 * `@/lib/storeConfig` (the unified accessor) or
 * `@/lib/storeConfig/defaults` (raw defaults only).
 */
export { DEFAULT_STORE_CONFIG, type StoreConfigShape } from '@/lib/storeConfig/defaults';
