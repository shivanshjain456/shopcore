/**
 * Rate-limit response header plumbing.
 *
 * Why this lives in its own file:
 *
 *   `applyRateLimit` runs inside the route handler and computes the
 *   remaining-budget info BEFORE the handler returns its NextResponse.
 *   Header attachment has to happen AFTER the response is built — i.e.
 *   in `withErrorHandling` or `jsonOk`/`jsonError`. We thread the info
 *   through the request-scoped AsyncLocalStorage (set up by Item 3 +
 *   used for `requestId` already) so the wrapper can pull it out at
 *   response time without every helper having to accept extra args.
 *
 * Stored shape: `{ limit, remaining, resetAt }` — the trio that
 * standard `X-RateLimit-*` headers map onto. We only stash the
 * MOST RESTRICTIVE window (smallest `remaining`) when a policy has
 * multiple windows, since clients only need to know how close they
 * are to the next 429.
 */
import { NextResponse } from 'next/server';
import { getRequestContext, runWithRequestContext } from '@/lib/log/context';

const STATE_KEY = '__rl_headers__';

export interface RateLimitHeaders {
  limit: number;
  remaining: number;
  resetAt: number;
}

/** Stash rate-limit info on the current request context's `state`
 *  side-channel. Lives on `state` (not `bindings`) so the structured
 *  logger does NOT emit this object on every log line — it's purely
 *  for `withErrorHandling` to read when building the response.
 *
 *  Idempotent — a tighter (smaller `remaining`) policy overrides a
 *  looser one so clients see the most accurate "how close to 429"
 *  number when multiple windows ran. */
export function stashRateLimitHeaders(rl: RateLimitHeaders): void {
  const ctx = getRequestContext();
  if (!ctx) return; // outside a request — nothing to attach
  const state = ctx.state ?? {};
  const existing = state[STATE_KEY] as RateLimitHeaders | undefined;
  if (!existing || rl.remaining < existing.remaining) {
    state[STATE_KEY] = rl;
  }
  ctx.state = state;
}

/** Pull the stashed rate-limit info; returns null when outside a
 *  request or when no policy ran for this request. */
export function readRateLimitHeaders(): RateLimitHeaders | null {
  const ctx = getRequestContext();
  if (!ctx?.state) return null;
  const v = ctx.state[STATE_KEY] as RateLimitHeaders | undefined;
  return v ?? null;
}

/** Translate the stashed object into the actual header trio. Returns
 *  an empty object when there's nothing to attach. */
export function buildRateLimitHeaderObject(): Record<string, string> {
  const rl = readRateLimitHeaders();
  if (!rl) return {};
  return {
    'X-RateLimit-Limit':     String(rl.limit),
    'X-RateLimit-Remaining': String(Math.max(0, rl.remaining)),
    'X-RateLimit-Reset':     String(Math.floor(rl.resetAt / 1000)),
  };
}

/** Convenience: attach headers to an existing NextResponse. We try
 *  in-place first (cheapest, no new object). NextResponse headers
 *  built by `NextResponse.json` ARE mutable in practice, so the
 *  rebuild branch is dead code at our scale — kept for forward-
 *  compatibility if Next changes the contract. */
export function attachRateLimitHeaders(res: NextResponse): NextResponse {
  const extra = buildRateLimitHeaderObject();
  if (Object.keys(extra).length === 0) return res;
  try {
    for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
    return res;
  } catch {
    const newHeaders = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) newHeaders.set(k, v);
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  }
}

// Re-export for callers that wrap things in their own ALS context.
export { runWithRequestContext };
