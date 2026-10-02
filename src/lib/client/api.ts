'use client';
/**
 * Client-side fetch wrapper.
 *
 * Two surfaces — choose based on the call site's needs:
 *
 *   1. `api<T>(path, init)` — legacy tagged-result API. Returns
 *      `{ ok, data, error, status, raw }`. Existing components rely
 *      on this shape. KEEP USING IT for any new code that wants to
 *      branch on `ok` without try/catch.
 *
 *   2. `apiOrThrow<T>(path, init)` — new throw-style API. Returns
 *      `T` on success, throws `ClientApiError` on any failure. Use
 *      for new code that uses standard async/await + try/catch
 *      ergonomics, especially for code that needs to special-case
 *      401 (re-auth), 429 (rate-limit), 0 (offline).
 *
 * Both surfaces share CSRF acquisition + Idempotency-Key plumbing.
 *
 * Error shape:
 *
 *   `ClientApiError` carries (status, code, clientMessage, issues?).
 *   `issues` is populated for ValidationError responses so form-level
 *   error UI can map each issue back to its field via `path`.
 *
 *   Special status values:
 *     0  — network failure / DNS / TLS / offline
 *     >0 — actual HTTP status from the server
 */

// ── CSRF helpers ─────────────────────────────────────────────────────────

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function ensureCsrf(): Promise<string> {
  let tok = readCookie('sc_csrf');
  if (tok) return tok;
  await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  tok = readCookie('sc_csrf');
  if (!tok) {
    // Surface this as a ClientApiError so call sites get consistent
    // typed handling rather than a vanilla Error.
    throw new ClientApiError(
      0, 'CSRF_UNAVAILABLE',
      'Could not establish a secure session. Please refresh the page.',
    );
  }
  return tok;
}

// ── ClientApiError ───────────────────────────────────────────────────────

/** All client-side fetch failures from `api()` / `apiOrThrow()` surface
 *  as this typed error. Use `isClientApiError(e)` in components to
 *  discriminate from other thrown values. */
export class ClientApiError extends Error {
  constructor(
    /** HTTP status (0 = network failure / offline). */
    public readonly status: number,
    /** Machine-readable error code from the server envelope
     *  (or our own `NETWORK_ERROR` / `OFFLINE` / `CSRF_UNAVAILABLE`
     *  / `RATE_LIMITED` for client-detected conditions). */
    public readonly code: string,
    /** Safe-to-display message. */
    public readonly clientMessage: string,
    /** Form-field issues for ValidationError responses. */
    public readonly issues?: Array<{ path: string; message: string }>,
    /** Raw response body for debugging. Logger-friendly. */
    public readonly raw?: Record<string, unknown>,
  ) {
    super(clientMessage);
    // instanceof reliability across TS targets (see lib/errors.ts).
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ClientApiError';
  }
}

/** Type guard for `try { ... } catch (e) { if (isClientApiError(e)) ... }`. */
export function isClientApiError(e: unknown): e is ClientApiError {
  return e instanceof ClientApiError;
}

// ── Idempotency-Key generator (unchanged) ────────────────────────────────

/** Generate a UUID v4 (RFC 4122). Used for Idempotency-Key headers. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const rnd = new Uint8Array(16);
  (typeof crypto !== 'undefined' ? crypto : { getRandomValues: (a: Uint8Array) => a.forEach((_, i, arr) => (arr[i] = Math.floor(Math.random() * 256))) })
    .getRandomValues(rnd);
  rnd[6] = (rnd[6] & 0x0f) | 0x40;
  rnd[8] = (rnd[8] & 0x3f) | 0x80;
  const h = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Shared call options ──────────────────────────────────────────────────

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Idempotency-Key header — caller MUST generate once per logical
   *  submit and reuse on retries. See `newIdempotencyKey()`. */
  idempotencyKey?: string;
  /** Extra headers (rarely needed; CSRF + Content-Type + Idempotency
   *  are managed for you). */
  headers?: Record<string, string>;
}

/** Tagged-result return — backwards-compatible shape for existing callers. */
export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Error code from the server envelope (set on `!ok`). */
  code?: string;
  /** Form-field issues from ValidationError responses. */
  issues?: Array<{ path: string; message: string }>;
  status: number;
  raw: Record<string, unknown>;
}

// ── Core fetch dispatcher (used by both surfaces) ────────────────────────

async function doFetch(path: string, init?: ApiInit): Promise<{
  res: Response | null;
  json: Record<string, unknown>;
  networkError: ClientApiError | null;
}> {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers ?? {}),
  };
  if (method !== 'GET') {
    try { headers['x-csrf-token'] = await ensureCsrf(); }
    catch (e) {
      if (isClientApiError(e)) return { res: null, json: {}, networkError: e };
      throw e;
    }
  }
  if (init?.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, {
      method, headers,
      credentials: 'same-origin',
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    // fetch() rejects on network failure / DNS error / CORS / abort.
    return {
      res: null,
      json: {},
      networkError: new ClientApiError(
        0, 'OFFLINE',
        'No internet connection. Please check your network and try again.',
        undefined,
        { underlying: String(e) },
      ),
    };
  }

  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; }
  catch { /* response is not JSON (502 nginx page, empty 204, etc.) */ }
  return { res, json, networkError: null };
}

// ── api() — tagged-result surface (legacy compatible) ───────────────────

export async function api<T = unknown>(
  path: string,
  init?: ApiInit,
): Promise<ApiResult<T>> {
  const { res, json, networkError } = await doFetch(path, init);
  if (networkError || !res) {
    return {
      ok: false,
      error: networkError?.clientMessage ?? 'Network error.',
      code: networkError?.code ?? 'NETWORK_ERROR',
      status: networkError?.status ?? 0,
      raw: {},
    };
  }
  // Envelope-aware: `ok` is true ONLY when the HTTP status is 2xx AND
  // the body's `ok` field isn't explicitly false. (Some legacy routes
  // return 200 + `{ ok: false }` for soft failures.)
  const envelopeOk = (json.ok as boolean | undefined) !== false;
  return {
    ok: res.ok && envelopeOk,
    data: json.data as T | undefined,
    error: json.error as string | undefined,
    code: json.code as string | undefined,
    issues: json.issues as Array<{ path: string; message: string }> | undefined,
    status: res.status,
    raw: json,
  };
}

// ── apiOrThrow() — throw-style surface (preferred for new code) ─────────

/** Same plumbing as `api()` but throws `ClientApiError` on any failure
 *  (HTTP non-2xx, envelope `ok:false`, network failure, parse error).
 *  Returns the unwrapped `data` payload directly on success.
 *
 *  Recommended usage:
 *
 *    try {
 *      const user = await apiOrThrow<User>('/api/auth/me');
 *      ...
 *    } catch (e) {
 *      if (isClientApiError(e)) {
 *        if (e.status === 401) { router.push('/login'); return; }
 *        if (e.status === 429) { setError(`Wait ${... }`); return; }
 *        if (e.status === 0)   { setError('No internet connection.'); return; }
 *        setError(e.clientMessage);
 *        return;
 *      }
 *      setError('Something went wrong. Please try again.');
 *    }
 */
export async function apiOrThrow<T = unknown>(
  path: string,
  init?: ApiInit,
): Promise<T> {
  const { res, json, networkError } = await doFetch(path, init);
  if (networkError) throw networkError;
  if (!res) {
    throw new ClientApiError(0, 'NETWORK_ERROR', 'Something went wrong. Please try again.');
  }
  const envelopeOk = (json.ok as boolean | undefined) !== false;
  if (res.ok && envelopeOk) {
    return json.data as T;
  }
  // Build a ClientApiError from the envelope.
  const code = (json.code as string | undefined)
    ?? (res.status === 429 ? 'RATE_LIMITED' : 'NETWORK_ERROR');
  const errorMsg = (json.error as string | undefined)
    ?? (res.status === 0 ? 'No internet connection.'
        : res.status >= 500 ? 'Service temporarily unavailable. Please try again.'
        : 'Something went wrong. Please try again.');
  throw new ClientApiError(
    res.status, code, errorMsg,
    json.issues as Array<{ path: string; message: string }> | undefined,
    json,
  );
}
