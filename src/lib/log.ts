/**
 * Structured logger — production-grade.
 *
 * Contract:
 *
 *   - One JSON object per line. stdout for debug/info, stderr for warn/error.
 *   - Every line carries: ts, level, msg, env, pid. Adds `requestId`
 *     when one is in scope (from `next/headers()` or our ALS wrapper).
 *   - PII / secret redaction is AUTOMATIC — call sites never have to
 *     mask phone numbers, tokens, or passwords. See `REDACT_FULL` and
 *     `REDACT_MASK` below for the rule tables.
 *   - The logger NEVER throws. Circular refs, BigInt, exotic prototypes
 *     all fall back to a safe stringified placeholder rather than
 *     crashing the request that emitted them.
 *   - In `NODE_ENV=test`, debug/info/warn are silenced; `error` still
 *     writes. Test scripts use `error` for genuine failures.
 *
 * Stable API:
 *
 *   log.debug(msg, fields?)
 *   log.info(msg, fields?)
 *   log.warn(msg, fields?)
 *   log.error(msg, fields?)
 *   log.child(bindings) → Logger      // bindings auto-merge into every call
 *
 * Migration note: this file replaces the original tiny logger but keeps
 * the exact same `log.{debug,info,warn,error}` surface — every existing
 * call site (Account State Machine, Phone Verification, etc.) works
 * unchanged AND now automatically gains requestId + PII masking.
 */
import { getRequestContext } from '@/lib/log/context';

// ── Levels ────────────────────────────────────────────────────────────────

type Level = 'debug' | 'info' | 'warn' | 'error';

// ── Redaction rules ───────────────────────────────────────────────────────
//
// Key names are matched case-insensitively. The redactor walks every
// nested object / array, never mutates the caller's input.

/** Keys whose VALUE is replaced wholesale with `[REDACTED]`. */
const REDACT_FULL = new Set<string>([
  'password',
  'passwordhash',
  'otp',
  'code',
  'token',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'csrf',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'utr',
  'receipt',
  'firebaseuid',
  'firebasephoneuid',
]);

/** Keys whose VALUE is partially masked — keep enough tail to debug
 *  correlation issues, hide enough to satisfy data-minimisation. */
const REDACT_MASK = new Set<string>([
  'email',
  'phone',
  'phonenumber',
  'mobile',
]);

/** Keys that LOOK sensitive by their suffix but are intentionally safe
 *  identifiers — explicit allowlist beats fuzzy substring matching for
 *  high-traffic IDs we want fully visible in logs. */
const NEVER_REDACT = new Set<string>([
  'userid', 'orderid', 'requestid', 'actorid',
  'sessionid', 'familyid', 'productid', 'cartid',
  'variantid', 'addressid', 'reviewid', 'returnid',
  'ticketid', 'paymentid', 'shipmentid', 'bannerid',
  'couponid', 'promotionid', 'campaignid', 'roomid',
  'messageid', 'subscriptionid', 'tierid', 'categoryid',
  'brandid', 'targetuserid', 'adminid', 'referredbyid',
  'status', 'role',
]);

// ── Mask helpers ──────────────────────────────────────────────────────────

/** Mask an email: keep the LAST 2 chars of the local part + full domain.
 *  `katrina@example.com` → `**rina@example.com`. Returns `[REDACTED]` for
 *  malformed input rather than leaking the raw value. */
function maskEmail(raw: string): string {
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return '[REDACTED]';
  const local  = raw.slice(0, at);
  const domain = raw.slice(at); // includes '@'
  if (local.length <= 2) return '*'.repeat(local.length) + domain;
  return '*'.repeat(local.length - 2) + local.slice(-2) + domain;
}

/** Mask a phone number — keep the leading `+91` (if present) and the
 *  last 4 digits. Non-string input is stringified first so callers
 *  passing a number don't bypass the mask. */
function maskPhone(raw: string): string {
  if (raw.length <= 4) return '*'.repeat(raw.length);
  const tail = raw.slice(-4);
  if (raw.startsWith('+')) {
    const cc = raw.slice(0, 3); // +91 (or whatever 3-char prefix)
    const middle = Math.max(0, raw.length - cc.length - 4);
    return cc + '*'.repeat(middle) + tail;
  }
  return '*'.repeat(raw.length - 4) + tail;
}

// ── Redaction ─────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]' as const;
const UNSERIALIZABLE = '[Unable to serialize]' as const;

/** Recursively redact an object/array. Returns a NEW value — never
 *  mutates the input. Handles cycles via a WeakSet seen-tracker. */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  return redactInner(value, seen);
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString() + 'n';
  if (t === 'symbol' || t === 'function') return undefined;
  // value is object-ish from here.
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (NEVER_REDACT.has(lower)) { out[k] = v; continue; }
    if (REDACT_FULL.has(lower))  { out[k] = REDACTED; continue; }
    if (REDACT_MASK.has(lower)) {
      const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
      if (s === '') { out[k] = v; continue; }
      out[k] = (lower === 'email') ? maskEmail(s) : maskPhone(s);
      continue;
    }
    out[k] = redactInner(v, seen);
  }
  return out;
}

// ── Safe stringify ────────────────────────────────────────────────────────

const MAX_LINE_BYTES = 10 * 1024; // 10 KB per the spec

/** JSON.stringify wrapped in belt-and-braces error handling. Returns the
 *  serialized line WITHOUT the trailing newline. On any failure emits a
 *  minimal fallback so call sites NEVER see an exception. */
function safeStringify(payload: Record<string, unknown>): string {
  let line: string;
  try {
    line = JSON.stringify(payload, (_k, v) => {
      // Belt: redact() already handled BigInt/Date/Error/circulars, but
      // JSON.stringify itself can still trip on Symbol-keyed property
      // values or weird Proxies. This replacer is the second wall.
      if (typeof v === 'bigint') return v.toString() + 'n';
      if (typeof v === 'function') return undefined;
      if (typeof v === 'symbol')   return undefined;
      return v;
    });
  } catch {
    try {
      line = JSON.stringify({
        ts:    new Date().toISOString(),
        level: 'error',
        msg:   'log.serialization_failed',
        env:   process.env.NODE_ENV,
        pid:   process.pid,
        originalMsg: typeof payload.msg === 'string' ? payload.msg : undefined,
      });
    } catch {
      // Truly cannot serialize anything — last-resort fixed string.
      line = '{"level":"error","msg":"log.serialization_failed"}';
    }
  }

  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    // Truncate by re-serializing with a `truncated` marker. We keep the
    // canonical envelope fields and drop everything else, since the
    // overflow is almost certainly in the caller's context object.
    try {
      const trimmed = {
        ts:        payload.ts,
        level:     payload.level,
        msg:       payload.msg,
        env:       payload.env,
        pid:       payload.pid,
        requestId: payload.requestId,
        truncated: true,
        originalBytes: Buffer.byteLength(line, 'utf8'),
      };
      line = JSON.stringify(trimmed);
    } catch { /* keep the oversized line; cap is advisory */ }
  }
  return line;
}

// ── Emit ──────────────────────────────────────────────────────────────────

/** Resolve the current request id. Order of precedence:
 *   1. Our ALS store (set by `runWithRequestContext` — covers BG jobs)
 *   2. Next.js `headers()` `x-request-id` (covers API routes + RSC)
 *   3. undefined (omit field entirely)
 *
 *  Wrapped in try/catch because `headers()` THROWS when called outside
 *  a request scope — log calls from module-load time would otherwise
 *  crash.                                                              */
function currentRequestId(): string | undefined {
  const ctx = getRequestContext();
  if (ctx?.requestId) return ctx.requestId;
  // Lazy/dynamic require via an indirected reference so webpack does NOT
  // walk `next/headers` when this module is pulled into a client bundle
  // (which happens via pincode → log etc.). Inside a real Node API
  // route this resolves to the real `next/headers` module.
  try {
    const req: ((m: string) => unknown) | undefined =
      (eval('typeof require') === 'function')
        ? (eval('require') as (m: string) => unknown)
        : undefined;
    if (!req) return undefined;
    const nh = req('next/headers') as { headers?: () => { get: (k: string) => string | null } } | null;
    const h = nh?.headers?.();
    const id = h?.get('x-request-id');
    return id ?? undefined;
  } catch {
    return undefined;
  }
}

/** Same resolver but for arbitrary request-bound bindings the caller's
 *  wrapper has stashed in our ALS store (e.g. routeName, userId). */
function currentBindings(): Record<string, unknown> | undefined {
  return getRequestContext()?.bindings;
}

function emit(
  level: Level,
  msg: string,
  fields: Record<string, unknown> | undefined,
  childBindings: Record<string, unknown> | undefined,
): void {
  // Silenced levels in test mode — early-return BEFORE doing any work.
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;

  // Build the envelope. Caller-supplied `fields` are REDACTED before
  // merge so a malicious / careless caller cannot inject a `msg`
  // override or pollute the canonical envelope fields.
  const cleanedFields = fields ? redact(fields) as Record<string, unknown> : {};
  const cleanedChild  = childBindings ? redact(childBindings) as Record<string, unknown> : {};
  const cleanedReqBindings = currentBindings()
    ? redact(currentBindings()) as Record<string, unknown>
    : {};

  const requestId = currentRequestId();

  const envelope: Record<string, unknown> = {
    ts:    new Date().toISOString(),
    level,
    msg,
    // NODE_ENV may legitimately be unset (e.g. ad-hoc `tsx` script run)
    // — default to 'development' so the field is ALWAYS present and log
    // shippers can rely on its existence.
    env:   process.env.NODE_ENV ?? 'development',
    pid:   process.pid,
  };
  if (requestId) envelope.requestId = requestId;

  // Merge order: request-store bindings ← child bindings ← per-call fields.
  // Per-call fields beat child beats store — most-specific wins. We then
  // re-apply canonical envelope fields LAST so no merge can clobber
  // `msg`, `level`, `ts`, `requestId`, `env`, `pid`.
  const merged: Record<string, unknown> = {
    ...cleanedReqBindings,
    ...cleanedChild,
    ...cleanedFields,
    ...envelope,
  };

  const line = safeStringify(merged);

  try {
    const out = (level === 'warn' || level === 'error')
      ? process.stderr : process.stdout;
    out.write(line + '\n');
  } catch {
    // Even the write failed — last resort: try the OTHER stream.
    try { process.stderr.write('{"level":"error","msg":"log.write_failed"}\n'); }
    catch { /* nothing we can do */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info (msg: string, fields?: Record<string, unknown>): void;
  warn (msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a NEW logger whose every call merges `bindings` into the
   *  fields object. Bindings are merged BEFORE per-call fields, so a
   *  per-call key beats the binding of the same name. Does not mutate
   *  the parent — `log.child({...})` is safe to call repeatedly. */
  child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(boundBindings: Record<string, unknown> | undefined): Logger {
  return {
    debug: (m, f) => emit('debug', m, f, boundBindings),
    info:  (m, f) => emit('info',  m, f, boundBindings),
    warn:  (m, f) => emit('warn',  m, f, boundBindings),
    error: (m, f) => emit('error', m, f, boundBindings),
    child: (extra) => makeLogger({ ...(boundBindings ?? {}), ...extra }),
  };
}

export const log: Logger = makeLogger(undefined);

// ── Convenience exports ───────────────────────────────────────────────────

/** Pull a request id from the X-Request-Id header or generate one.
 *  Format: 12 hex chars — enough for cross-referencing log lines.
 *  Kept here (not moved to `context.ts`) for backwards compatibility:
 *  existing callers import it as `import { newRequestId } from '@/lib/log'`. */
export function newRequestId(): string {
  // Use crypto.randomBytes when available (Node), Math.random fallback
  // for Edge-runtime callers. Both are sufficient for correlation
  // (NOT a security token).
  // Dynamic require — keeps webpack from following this into client bundles.
  try {
    const req: ((m: string) => unknown) | undefined =
      (eval('typeof require') === 'function')
        ? (eval('require') as (m: string) => unknown)
        : undefined;
    if (!req) throw new Error('no require');
    const c = req('node:crypto') as { randomBytes(n: number): Buffer };
    return 'req_' + c.randomBytes(6).toString('hex');
  } catch {
    return 'req_' + Math.random().toString(16).slice(2, 14);
  }
}

/** Re-exported for code that wants to use the ALS wrapper directly
 *  (background jobs, test harnesses, scripts that want correlated lines). */
export { runWithRequestContext, getRequestContext } from '@/lib/log/context';
