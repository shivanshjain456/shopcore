/**
 * ShopCore — typed error class hierarchy + Prisma error mapping
 * + process-level safety net.
 *
 * Contract (binding for every server module — see CONTEXT.md §17):
 *
 *   Rule 1. Expected business failures → tagged result `{ ok: false, reason }`.
 *           Services NEVER throw for these.
 *   Rule 2. Unexpected failures → throw a `ShopCoreError` subclass.
 *           Services NEVER throw raw strings or vanilla `new Error('...')`.
 *   Rule 3. External-service failures (Firebase, India Post, SMTP, etc.)
 *           are ALWAYS wrapped in `ExternalServiceError` with the
 *           original as `cause`. We never let third-party error shapes
 *           leak to the route handler.
 *
 * Why a typed hierarchy:
 *
 *   - `handleError` in `lib/api.ts` discriminates by `instanceof` and
 *     maps to the correct HTTP status + envelope WITHOUT a giant
 *     switch on string codes.
 *   - The `code` string IS public API — mobile clients and the
 *     browser-side fetch wrapper switch on it. Adding new codes is
 *     additive; renaming is a breaking change.
 *   - Stack traces and internal `message` NEVER reach the client;
 *     only the safe `clientMessage` does.
 *
 * Why a separate `clientMessage`:
 *
 *   `message` is for logs ("Prisma P2002 on User.email"). `clientMessage`
 *   is for humans ("This email address is already registered."). One
 *   carries internal context; the other carries product copy. Keeping
 *   them separate is the difference between professional UX and
 *   accidentally leaking schema details to attackers.
 */

// ── Options bag passed to every subclass constructor ─────────────────────

export interface ShopCoreErrorOptions {
  /** Stable machine-readable identifier (e.g. `EMAIL_TAKEN`).
   *  Treat as public API — never rename without a deprecation plan. */
  code?: string;
  /** Safe-to-display message for the end user. Defaults to a generic
   *  per-class string if omitted; subclasses override. */
  clientMessage?: string;
  /** Original error that triggered this one — chained via the
   *  ES2022 `cause` slot. Logged, NEVER sent to clients. */
  cause?: unknown;
  /** Additional structured fields for the log line. Auto-redacted by
   *  the logger (Item 3). Use for IDs, status codes, operation names. */
  context?: Record<string, unknown>;
}

// ── Base class ───────────────────────────────────────────────────────────

/** The root of the ShopCore error hierarchy. Every server error that
 *  escapes a service boundary MUST be (or extend) this class. */
export class ShopCoreError extends Error {
  /** HTTP status this class maps to. Overridden per subclass. */
  public readonly statusCode: number = 500;
  /** Machine-readable error code. */
  public readonly code: string;
  /** Client-safe message — what the user sees in the UI. */
  public readonly clientMessage: string;
  /** Structured fields for the log line. Auto-redacted. */
  public readonly context: Record<string, unknown> | undefined;
  /** Original error if any. ES2022 `cause` shape. */
  public override readonly cause: unknown;

  constructor(message: string, opts: ShopCoreErrorOptions = {}) {
    super(message);
    // Required for `instanceof` to work reliably across TS transpile
    // targets (ES5/ES2015) — otherwise `Object.create(Error.prototype)`
    // is used and subclass instanceof checks return false.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.clientMessage = opts.clientMessage ?? 'An unexpected error occurred.';
    this.context = opts.context;
    this.cause = opts.cause;
  }
}

// ── Subclasses (one per HTTP status family) ──────────────────────────────

/** 400 — input validation or business-rule violation. */
export class ValidationError extends ShopCoreError {
  public override readonly statusCode = 400;
  constructor(message: string, opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'VALIDATION_ERROR',
      clientMessage: opts.clientMessage ?? message,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 401 — caller is not authenticated / session is invalid. */
export class AuthError extends ShopCoreError {
  public override readonly statusCode = 401;
  constructor(message: string = 'Authentication required.', opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'UNAUTHENTICATED',
      clientMessage: opts.clientMessage ?? 'Please sign in to continue.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 403 — caller is authenticated but not allowed (role / CSRF / etc.). */
export class ForbiddenError extends ShopCoreError {
  public override readonly statusCode = 403;
  constructor(message: string = 'Forbidden.', opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'FORBIDDEN',
      clientMessage: opts.clientMessage ?? 'You do not have permission to perform this action.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 404 — the target entity does not exist (or the actor is not allowed
 *  to see that it exists — same response either way). */
export class NotFoundError extends ShopCoreError {
  public override readonly statusCode = 404;
  constructor(message: string = 'Not found.', opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'NOT_FOUND',
      clientMessage: opts.clientMessage ?? 'The requested item could not be found.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 409 — uniqueness violation, illegal state transition, optimistic-
 *  lock contention. Caller should retry / pick different input. */
export class ConflictError extends ShopCoreError {
  public override readonly statusCode = 409;
  constructor(message: string, opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'CONFLICT',
      clientMessage: opts.clientMessage ?? 'This action conflicts with the current state. Please refresh and try again.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 429 — rate-limit exceeded. The `context.retryAfterSeconds` field is
 *  read by `handleError` to set the `Retry-After` HTTP header. */
export class RateLimitError extends ShopCoreError {
  public override readonly statusCode = 429;
  constructor(message: string = 'Too many requests.', opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'RATE_LIMITED',
      clientMessage: opts.clientMessage ?? 'Too many attempts. Please wait before trying again.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 502 — an external service (Firebase, SMTP, India Post, ...) failed
 *  in a way we cannot recover from in this request. The internal
 *  message contains the service name; the client message NEVER does. */
export class ExternalServiceError extends ShopCoreError {
  public override readonly statusCode = 502;
  constructor(message: string, opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'EXTERNAL_SERVICE_ERROR',
      clientMessage: opts.clientMessage ?? 'An external service is temporarily unavailable. Please try again shortly.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

/** 500 — anything we couldn't classify. Catch-all bucket; should be
 *  rare in production. */
export class InternalError extends ShopCoreError {
  public override readonly statusCode = 500;
  constructor(message: string, opts: ShopCoreErrorOptions = {}) {
    super(message, {
      code: opts.code ?? 'INTERNAL_ERROR',
      clientMessage: opts.clientMessage ?? 'An unexpected error occurred. Please try again.',
      cause: opts.cause,
      context: opts.context,
    });
  }
}

// ── Prisma error mapping ─────────────────────────────────────────────────
//
// Prisma throws structured errors with stable `.code` strings. We map
// the well-known ones to our hierarchy so service modules can wrap
// every prisma call with a single `try { ... } catch (e) { throw mapPrismaError(e) }`
// pattern WITHOUT manually checking each code.
//
// The full Prisma error code catalogue is at:
//   https://www.prisma.io/docs/orm/reference/error-reference
//
// We deliberately map "many" codes to InternalError so the surface
// stays predictable — only the codes that BUSINESS LOGIC cares about
// get specific subclasses (P2002 / P2025 / P2003 / P2024).

interface PrismaErrorShape {
  code?: string;
  meta?: { target?: string[] | string; field_name?: string };
  message?: string;
  // PrismaClientInitializationError has `clientVersion` but no `code`.
  clientVersion?: string;
  // Name discriminates between Prisma error classes without importing
  // them (avoids a hard dep on @prisma/client/runtime which adds
  // bundle weight to anything that imports this module).
  name?: string;
}

/** Map an unknown thrown value into a `ShopCoreError`. If `e` is already
 *  a `ShopCoreError` it is returned unchanged — this lets service
 *  modules call `throw mapPrismaError(e)` defensively even when the
 *  caller has already wrapped it.
 *
 *  Returns (does not throw) so callers can decide whether to re-throw
 *  or just log. */
export function mapPrismaError(e: unknown): ShopCoreError {
  if (e instanceof ShopCoreError) return e;
  const err = e as PrismaErrorShape;
  const code = err?.code;
  const name = err?.name;

  // PrismaClientInitializationError — DB can't start at all.
  if (name === 'PrismaClientInitializationError') {
    return new InternalError(
      `Database initialisation failed: ${err.message ?? 'unknown'}`,
      { code: 'DB_INIT_FAILURE', cause: e },
    );
  }

  // Connection pool / engine timeout.
  if (code === 'P2024' || name === 'PrismaClientUnknownRequestError') {
    return new InternalError(
      `Database timeout: ${err.message ?? 'unknown'}`,
      { code: 'DB_TIMEOUT', cause: e },
    );
  }

  if (code === 'P2002') {
    // Unique constraint violation. Extract the field for the log line
    // ONLY — the client message stays generic to avoid leaking the
    // column structure.
    const target = err.meta?.target;
    const field = Array.isArray(target) ? target.join(',') : (target ?? 'unknown');
    return new ConflictError(
      `Unique constraint violation on field(s): ${field}`,
      {
        code: 'UNIQUE_CONSTRAINT',
        clientMessage: 'This value is already in use. Please choose a different one.',
        cause: e,
        context: { field },
      },
    );
  }

  if (code === 'P2025') {
    // Record not found — happens on update/delete of a non-existent row,
    // or on our optimistic-concurrency `where: { id, status }` writes.
    return new NotFoundError(
      err.message ?? 'Record not found.',
      { code: 'RECORD_NOT_FOUND', cause: e },
    );
  }

  if (code === 'P2003') {
    // Foreign key constraint failed.
    return new ConflictError(
      `Foreign key constraint failed: ${err.meta?.field_name ?? 'unknown'}`,
      {
        code: 'FK_CONSTRAINT',
        clientMessage: 'This action conflicts with related data and cannot be completed.',
        cause: e,
        context: { field: err.meta?.field_name },
      },
    );
  }

  // Generic Prisma known-request error or anything else.
  if (code && code.startsWith('P')) {
    return new InternalError(
      `Prisma ${code}: ${err.message ?? 'unknown'}`,
      { code: 'PRISMA_ERROR', cause: e, context: { prismaCode: code } },
    );
  }

  // Not a Prisma error — generic internal.
  return new InternalError(
    (err.message as string | undefined) ?? 'Unknown error',
    { code: 'INTERNAL_ERROR', cause: e },
  );
}

// ── Helper: wrap external-service calls ──────────────────────────────────

/** Run an async fn; on any throw, wrap in `ExternalServiceError`. Used
 *  by integrations to the outside world (Firebase, SMTP, India Post). */
export async function wrapExternal<T>(
  serviceName: string,
  operation: string,
  fn: () => Promise<T>,
  opts?: { code?: string; clientMessage?: string },
): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof ShopCoreError) throw e;
    throw new ExternalServiceError(
      `${serviceName}.${operation} failed: ${(e as Error)?.message ?? 'unknown'}`,
      {
        code: opts?.code ?? `${serviceName.toUpperCase()}_UNAVAILABLE`,
        clientMessage: opts?.clientMessage,
        cause: e,
        context: { service: serviceName, operation },
      },
    );
  }
}

// ── Process-level safety net ─────────────────────────────────────────────
//
// `unhandledRejection` and `uncaughtException` are the LAST line of
// defence. Without these, a single async typo (await on a function
// that throws synchronously) can crash the entire Node process or
// produce silent ghost errors.
//
// We log structurally and do NOT call process.exit() — Next.js has its
// own crash semantics; double-handling here causes weird shutdowns
// during hot-reload in dev.
//
// Idempotency: the registration flag prevents double-binding when this
// module is reloaded by Next.js's dev-mode HMR.

const _PROCESS_FLAG = Symbol.for('shopcore.process_handlers_registered');
interface GlobalWithFlag { [k: symbol]: true | undefined }

/** Register `unhandledRejection` + `uncaughtException` handlers exactly
 *  once per process. Safe to call from multiple module-load points
 *  (the second + caller is a no-op). */
export function registerProcessErrorHandlers(): void {
  const g = globalThis as unknown as GlobalWithFlag;
  if (g[_PROCESS_FLAG]) return;
  g[_PROCESS_FLAG] = true;

  // Browser/Edge runtime — `process.on` doesn't exist. Bail silently.
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;

  // Dynamic-require the logger so this file stays import-safe in Edge.
  // (Same webpack-safe pattern as `log.ts` itself.)
  type LoggerLike = { error: (msg: string, fields?: Record<string, unknown>) => void };
  // Box pattern — TS narrows a bare `let x = null` to `null` after the
  // try-block. Wrapping in a single-field object preserves the union.
  const logBox: { v: LoggerLike | null } = { v: null };
  try {
    const req: ((m: string) => unknown) | undefined =
      (eval('typeof require') === 'function')
        ? (eval('require') as (m: string) => unknown)
        : undefined;
    if (req) {
      const mod = req('./log') as { log?: LoggerLike };
      logBox.v = mod?.log ?? null;
    }
  } catch { /* fall through to console-of-last-resort below */ }

  const emit = (msg: string, fields: Record<string, unknown>) => {
    if (logBox.v) { logBox.v.error(msg, fields); return; }
    // Last-resort fallback. We deliberately use process.stderr.write
    // directly — the audit recognises this file as a writer.
    try {
      process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(), level: 'error', msg, ...fields,
      }) + '\n');
    } catch { /* nothing we can do */ }
  };

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason as Error | undefined;
    emit('process.unhandled_rejection', {
      err,
      errName: err?.name,
      errMessage: err?.message ?? String(reason),
    });
    // Do NOT exit — Next.js can survive unhandled rejections, and
    // recovering is better than a 502 for every in-flight request.
  });

  process.on('uncaughtException', (err: Error) => {
    emit('process.uncaught_exception', {
      err,
      errName: err?.name,
      errMessage: err?.message ?? String(err),
    });
    // Same rationale — leave shutdown decisions to Next.js / the
    // process supervisor (systemd).
  });
}
