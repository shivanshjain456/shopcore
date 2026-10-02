/**
 * Helpers for API route handlers — uniform JSON errors, error mapping,
 * and the `withErrorHandling()` higher-order wrapper that every route
 * handler under `src/app/api/**` runs through.
 *
 * `handleError` is the central choke-point for unhandled exceptions in
 * every API route. It:
 *   - Translates the full `ShopCoreError` hierarchy + Prisma errors
 *     into 4xx/5xx JSON envelopes with the correct status codes
 *   - Logs UNEXPECTED errors at `error` level, EXPECTED ones at `warn`
 *     (CSRF rejections, validation failures) — keeps the error stream
 *     focused on genuine problems
 *   - Strips stack traces and internal messages from the response
 *     body — clients only ever see `clientMessage` + `code`
 *   - Reads `e.context.retryAfterSeconds` on `RateLimitError` to set
 *     the `Retry-After` HTTP header
 *
 * `withErrorHandling` is the canonical route-handler wrapper:
 *
 *   export const POST = withErrorHandling(async (req, ctx) => {
 *     assertCsrf();
 *     const body = MySchema.parse(await req.json());
 *     // throw new ValidationError(...) or return jsonOk(...)
 *   });
 *
 *   It establishes the AsyncLocalStorage request-context (so every log
 *   line inside the handler carries `requestId`), catches every error,
 *   and routes it through `handleError`. Replaces hand-rolled
 *   `try { ... } catch (e) { return handleError(e) }` blocks.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { CsrfError } from '@/lib/security/csrf';
import { AdminGuardError } from '@/lib/admin/guards';
import { log, runWithRequestContext, newRequestId } from '@/lib/log';
import {
  ShopCoreError, ValidationError, AuthError, ForbiddenError,
  NotFoundError, ConflictError, RateLimitError, ExternalServiceError,
  InternalError, mapPrismaError,
} from '@/lib/errors';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { attachRateLimitHeaders } from '@/lib/security/rateLimitHeaders';

// ── Plain success / failure helpers (unchanged public API) ───────────────

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

// ── Route-path correlator for log lines ──────────────────────────────────

function tryRoutePath(): string | undefined {
  try {
    const req: ((m: string) => unknown) | undefined =
      (eval('typeof require') === 'function')
        ? (eval('require') as (m: string) => unknown)
        : undefined;
    if (!req) return undefined;
    const nh = req('next/headers') as { headers?: () => { get: (k: string) => string | null } } | null;
    const h = nh?.headers?.();
    return (
      h?.get('x-invoke-path')
      ?? h?.get('next-url')
      ?? h?.get('referer')
      ?? undefined
    );
  } catch { return undefined; }
}

// ── The error router ─────────────────────────────────────────────────────

/** Detect Prisma errors by the well-known `code` shape WITHOUT importing
 *  @prisma/client/runtime (which would bloat the Edge bundle). */
function isLikelyPrismaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: string }).code;
  const name = (e as { name?: string }).name;
  return (
    (typeof code === 'string' && code.startsWith('P'))
    || name === 'PrismaClientKnownRequestError'
    || name === 'PrismaClientUnknownRequestError'
    || name === 'PrismaClientInitializationError'
    || name === 'PrismaClientValidationError'
  );
}

/** Pretty-print a ZodError for the client. Keeps the first issue as the
 *  top-level `error` (human-readable), surfaces every issue under
 *  `issues` for richer form-field rendering. */
function zodErrorBody(e: ZodError) {
  const first = e.issues[0];
  return {
    error: first?.message ?? 'Validation failed.',
    code: 'VALIDATION_ERROR',
    issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/** Build the response envelope for a ShopCoreError. Strips internal
 *  message, stack, and context — only the safe-to-display fields go. */
function envelopeFor(err: ShopCoreError): Record<string, unknown> {
  return {
    ok: false,
    error: err.clientMessage,
    code: err.code,
  };
}

/** The central error router. Defensive — wrapped in an outer try/catch
 *  so that even a bug in this function CANNOT bubble out as a raw
 *  unhandled exception. */
export function handleError(e: unknown): NextResponse {
  try {
    // 1. ZodError — most common 400 path.
    if (e instanceof ZodError) {
      log.warn('api.validation_error', {
        route: tryRoutePath(),
        issueCount: e.issues.length,
      });
      return NextResponse.json(
        { ok: false, ...zodErrorBody(e) },
        { status: 400 },
      );
    }

    // 2. CsrfError — operationally interesting but expected (bot
    //    traffic, stale tabs). Log at warn so the error stream stays
    //    focused on genuine problems.
    if (e instanceof CsrfError) {
      log.warn('api.csrf_rejected', { route: tryRoutePath(), msg: e.message });
      return NextResponse.json(
        { ok: false, error: 'Forbidden', code: 'CSRF_ERROR' },
        { status: 403 },
      );
    }

    // 3. AdminGuardError carries its own NextResponse already (legacy
    //    pattern from before this feature). Pass it through.
    if (e instanceof AdminGuardError) return e.response;

    // 4. Prisma error — map to our hierarchy, then continue down the
    //    chain so the ShopCoreError branch handles the envelope.
    if (isLikelyPrismaError(e) && !(e instanceof ShopCoreError)) {
      e = mapPrismaError(e);
    }

    // 5. ShopCoreError hierarchy — the main path.
    if (e instanceof ShopCoreError) {
      // Logging level depends on severity:
      //   - 4xx (client error) → warn
      //   - 5xx (our problem) → error
      const isServerError = e.statusCode >= 500;
      const logFn = isServerError ? log.error : log.warn;
      logFn.call(log, 'api.error', {
        route: tryRoutePath(),
        statusCode: e.statusCode,
        // We use `errorCode` (not `code`) here because the structured
        // logger's REDACT_FULL list includes `code` to mask OTP plaintext
        // — calling it `errorCode` keeps the error-class code visible in
        // logs while preserving OTP-code redaction everywhere else.
        errorCode: e.code,
        // `err` field is reshaped by the logger's redactor into
        // `{name, message, stack}`.
        err: e,
        // `cause` is logged for chained errors (e.g. the underlying
        // Firebase error inside an ExternalServiceError).
        cause: e.cause ? String(e.cause) : undefined,
        context: e.context,
      });

      const headers: Record<string, string> = {};
      // RateLimitError carries Retry-After in its context.
      if (e instanceof RateLimitError) {
        const retry = e.context?.retryAfterSeconds;
        if (typeof retry === 'number' && retry > 0) {
          headers['Retry-After'] = String(retry);
        }
      }

      const body = envelopeFor(e);
      // ZodError-style issues survive on ValidationError.context too —
      // surface them for the client when present.
      const issues = e.context?.issues;
      if (Array.isArray(issues)) (body as Record<string, unknown>).issues = issues;

      return NextResponse.json(body, { status: e.statusCode, headers });
    }

    // 6. Vanilla Error / unknown — last-resort 500.
    const err = e as Error;
    log.error('api.unhandled', {
      route: tryRoutePath(),
      err,
      errName: err?.name,
    });
    return NextResponse.json(
      { ok: false, error: 'An unexpected error occurred.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  } catch (handlerErr) {
    // handleError itself blew up — emit a fixed minimal 500 and let
    // the process-level handler log the meta-failure. Returning
    // ANYTHING here is better than throwing.
    try {
      log.error('api.handle_error_failure', { err: handlerErr });
    } catch { /* nothing we can do */ }
    return NextResponse.json(
      { ok: false, error: 'An unexpected error occurred.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

// ── withErrorHandling — the canonical route wrapper ─────────────────────

/** Signature of a Next.js 14 App Router route handler. */
export type RouteHandler<P = Record<string, string>> =
  (req: NextRequest, ctx: { params: P }) => Promise<NextResponse> | NextResponse;

/** Wrap a route handler so that:
 *
 *   1. The request-scoped AsyncLocalStorage is initialised with the
 *      inbound `x-request-id` (or a fresh one), so every `log.*` call
 *      inside the handler automatically carries `requestId`.
 *   2. Every thrown error — typed, Prisma, Zod, vanilla — is routed
 *      through `handleError()` and turned into the canonical JSON
 *      envelope with the correct status code.
 *
 *  Generic-preserving: callers do not lose their route-param types. */
export function withErrorHandling<P = Record<string, string>>(
  handler: RouteHandler<P>,
): RouteHandler<P> {
  return async (req, ctx) => {
    const requestId = req.headers.get('x-request-id') ?? newRequestId();
    return runWithRequestContext({ requestId }, async () => {
      try {
        // Global per-IP cap — applied to EVERY API request as the first
        // step. Lives here (Node runtime) rather than in middleware
        // (Edge runtime) because the rate-limit store needs
        // AsyncLocalStorage + in-memory Map access that Edge can't
        // give us. The `global` policy is the only one with
        // `skipInTest: false`, so this fires in every environment.
        await applyRateLimit('global', req);
        const response = await handler(req, ctx);
        // Successful response — fold any X-RateLimit-* headers stashed
        // by per-route `applyRateLimit` calls into the outgoing headers.
        return attachRateLimitHeaders(response);
      } catch (e) {
        // Errors also get rate-limit headers attached so 429 responses
        // tell the client exactly when to retry, and 4xx/5xx responses
        // still surface budget info.
        return attachRateLimitHeaders(handleError(e));
      }
    });
  };
}

// ── Re-exports for callers who want the classes from one place ──────────

export {
  ShopCoreError, ValidationError, AuthError, ForbiddenError,
  NotFoundError, ConflictError, RateLimitError, ExternalServiceError,
  InternalError,
};
