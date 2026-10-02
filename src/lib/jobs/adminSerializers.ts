/**
 * Serialisers that prepare Job / JobSchedule rows for admin API responses.
 *
 * Concerns:
 *   - Parse `payload`, `result`, `error` JSON columns into objects (admins
 *     get structured fields, not raw escape strings).
 *   - Mask PII in payloads (email addresses) so the admin dashboard does
 *     not splash raw addresses to anyone who happens to be screen-sharing.
 *     This mirrors the redaction the structured logger applies to log
 *     fields named `email` / `to` / `phone`.
 *   - Strip the reserved `__dedupKey` field so the dashboard payload
 *     view doesn't show our internal bookkeeping.
 *
 * The "list" projection (`toJobRow`) omits the heavy `payload` JSON to
 * keep list pages fast. The "detail" projection (`toJobDetail`) includes
 * everything, post-redaction.
 */
import type { Job, JobSchedule } from '@prisma/client';
import { DEDUP_KEY_FIELD } from '@/lib/jobs/producer';

// ── PII redaction helpers ─────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+?\d{8,15}$/;
const EMAIL_KEYS = new Set(['email', 'to', 'cc', 'bcc', 'recipient', 'recipientEmail', 'userEmail']);
const PHONE_KEYS = new Set(['phone', 'mobile', 'phoneNumber']);

function maskEmail(addr: string): string {
  const at = addr.indexOf('@');
  if (at <= 0) return '***';
  const u = addr.slice(0, at);
  const h = addr.slice(at + 1);
  const masked = u.length <= 2 ? '*'.repeat(u.length) : u[0] + '***' + u[u.length - 1];
  return `${masked}@${h}`;
}

function maskPhone(p: string): string {
  // Keep last 4 digits, mask the rest. Plus sign preserved if present.
  const digits = p.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  const tail = digits.slice(-4);
  const head = p.startsWith('+') ? '+' : '';
  return `${head}${'*'.repeat(Math.max(0, p.length - tail.length - head.length))}${tail}`;
}

/**
 * Recursively redact a parsed JSON payload. Returns a NEW object — never
 * mutates the input. Strips the reserved dedup key.
 */
function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactPayload(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === DEDUP_KEY_FIELD) continue;             // strip internal bookkeeping
      if (typeof v === 'string') {
        if (EMAIL_KEYS.has(k) && EMAIL_RE.test(v))   { out[k] = maskEmail(v); continue; }
        if (PHONE_KEYS.has(k) && E164_RE.test(v))    { out[k] = maskPhone(v); continue; }
        // Defensive: a stray email anywhere in a payload (not necessarily
        // under a known key) is masked too — admin view never leaks raw.
        if (EMAIL_RE.test(v))                        { out[k] = maskEmail(v); continue; }
      }
      out[k] = redactPayload(v);
    }
    return out;
  }
  return value;
}

function safeJsonParse(s: string | null): unknown {
  if (s === null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// ── Public projections ────────────────────────────────────────────────────

export interface JobRow {
  id:           string;
  type:         string;
  status:       string;
  priority:     number;
  attempts:     number;
  maxAttempts:  number;
  queueName:    string;
  runAt:        string;
  startedAt:    string | null;
  completedAt:  string | null;
  failedAt:     string | null;
  createdAt:    string;
  updatedAt:    string;
  error:        unknown;
  hasResult:    boolean;
}

export function toJobRow(j: Job): JobRow {
  return {
    id:          j.id,
    type:        j.type,
    status:      j.status,
    priority:    j.priority,
    attempts:    j.attempts,
    maxAttempts: j.maxAttempts,
    queueName:   j.queueName,
    runAt:       j.runAt.toISOString(),
    startedAt:   j.startedAt   ? j.startedAt.toISOString()   : null,
    completedAt: j.completedAt ? j.completedAt.toISOString() : null,
    failedAt:    j.failedAt    ? j.failedAt.toISOString()    : null,
    createdAt:   j.createdAt.toISOString(),
    updatedAt:   j.updatedAt.toISOString(),
    error:       safeJsonParse(j.error),
    hasResult:   j.result !== null,
  };
}

export interface JobDetail extends JobRow {
  payload:     unknown;
  result:      unknown;
  parentJobId: string | null;
  lockToken:   string | null;
  lockExpiresAt: string | null;
}

export function toJobDetail(j: Job): JobDetail {
  return {
    ...toJobRow(j),
    payload:       redactPayload(safeJsonParse(j.payload)),
    result:        safeJsonParse(j.result),
    parentJobId:   j.parentJobId,
    // The lock token isn't sensitive (it's a random UUID), but it IS
    // operational — surface it so an admin debugging a stuck job can
    // correlate with runner logs.
    lockToken:     j.lockToken,
    lockExpiresAt: j.lockExpiresAt ? j.lockExpiresAt.toISOString() : null,
  };
}

export interface ScheduleRow {
  id:             string;
  name:           string;
  jobType:        string;
  cronExpression: string;
  queueName:      string;
  isActive:       boolean;
  lastRunAt:      string | null;
  nextRunAt:      string;
  payload:        unknown;
  createdAt:      string;
  updatedAt:      string;
}

export function toScheduleRow(s: JobSchedule): ScheduleRow {
  return {
    id:             s.id,
    name:           s.name,
    jobType:        s.jobType,
    cronExpression: s.cronExpression,
    queueName:      s.queueName,
    isActive:       s.isActive,
    lastRunAt:      s.lastRunAt ? s.lastRunAt.toISOString() : null,
    nextRunAt:      s.nextRunAt.toISOString(),
    payload:        safeJsonParse(s.payload),
    createdAt:      s.createdAt.toISOString(),
    updatedAt:      s.updatedAt.toISOString(),
  };
}
