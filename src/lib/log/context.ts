/**
 * Request-scoped logging context — backed by Node 20's `AsyncLocalStorage`
 * when available (server runtime), and a no-op shim otherwise (Edge / browser
 * bundles that webpack happens to pull this module into).
 *
 * Why the runtime-detection dance:
 *
 *   The logger (`src/lib/log.ts`) is imported transitively from a few
 *   files that ALSO get reached by the client bundle (e.g. the password
 *   policy validator, used in both signup-form validation and the
 *   `<PasswordStrengthMeter>`). Webpack walks every static import and
 *   refuses to bundle `node:async_hooks`. Using a `try { require() }`
 *   wrapper lets webpack tree-shake the Node import out of the client
 *   bundle entirely while the server still gets full ALS.
 *
 *   Edge runtime: also no `AsyncLocalStorage`. Same fallback applies —
 *   middleware deals in HTTP headers, never logs through this module.
 *
 * Public API mirrors a real AsyncLocalStorage:
 *
 *   - `runWithRequestContext(ctx, fn)` runs `fn` with `ctx` bound
 *   - `getRequestContext()` returns the current store or undefined
 *   - `withBindings(base, add)` returns a merged context object
 */

export interface RequestLogContext {
  requestId?: string;
  /** Any additional bindings a wrapper wants to inject (e.g. userId).
   *  Callers should prefer `log.child({ ... })` for per-call-site
   *  bindings; this is for true request-scoped data. */
  bindings?: Record<string, unknown>;
  /** Side-channel for context that should NOT appear in log lines —
   *  used by the rate-limit headers helper to stash post-check
   *  budget info that `withErrorHandling` reads on response, without
   *  polluting every log line with `__rl_headers__`. */
  state?: Record<string, unknown>;
}

// ── Storage backend (lazy, server-only) ──────────────────────────────────

interface MinimalALS<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

let _storage: MinimalALS<RequestLogContext> | null = null;
let _initTried = false;

function getStorage(): MinimalALS<RequestLogContext> | null {
  if (_storage) return _storage;
  if (_initTried) return null;
  _initTried = true;
  // Dynamic-eval'd require so webpack does NOT follow this into the
  // client bundle. `node:async_hooks` is unavailable in Edge + browser;
  // we gracefully degrade to a no-op there.
  try {
    const req: ((m: string) => unknown) | undefined =
      (eval('typeof require') === 'function')
        ? (eval('require') as (m: string) => unknown)
        : undefined;
    if (!req) return null;
    const ah = req('node:async_hooks') as {
      AsyncLocalStorage: new <T>() => MinimalALS<T>;
    };
    _storage = new ah.AsyncLocalStorage<RequestLogContext>();
    return _storage;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Run `fn` with `ctx` bound to the current async-context. Logs emitted
 *  inside `fn` (and across any awaits / Promise chains it spawns) will
 *  see `requestId` automatically. */
export function runWithRequestContext<T>(
  ctx: RequestLogContext,
  fn: () => T,
): T {
  const s = getStorage();
  if (!s) return fn();
  return s.run(ctx, fn);
}

/** Read the current store. Returns `undefined` outside any
 *  `runWithRequestContext` scope (or in environments without ALS).
 *  Never throws. */
export function getRequestContext(): RequestLogContext | undefined {
  const s = getStorage();
  if (!s) return undefined;
  try { return s.getStore(); }
  catch { return undefined; }
}

/** Merge additional bindings into a base context — non-mutating. */
export function withBindings(
  base: RequestLogContext | undefined,
  add: Record<string, unknown>,
): RequestLogContext {
  return {
    requestId: base?.requestId,
    bindings: { ...(base?.bindings ?? {}), ...add },
  };
}
