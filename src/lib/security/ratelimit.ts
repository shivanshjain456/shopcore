/**
 * Rate-limiting public surface — `applyRateLimit()` is the canonical
 * call used by every API route.
 *
 *   await applyRateLimit('auth.login', req, { email });
 *
 * On success: stashes header info on the request-scoped ALS so
 * `withErrorHandling` can attach `X-RateLimit-*` to the outgoing
 * response.
 * On exceed: throws `RateLimitError` — caught by `withErrorHandling`
 * → `handleError` → 429 + `Retry-After`.
 *
 * Legacy: the old `rateLimit(key, max, windowSec): RateLimitResult`
 * function from the previous in-memory limiter is kept here as a
 * @deprecated shim that delegates to the new store. This is so any
 * call site we missed during migration still compiles and runs
 * correctly while we hunt it down via the static audit.
 */
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { RateLimitError, InternalError } from '@/lib/errors';
import { log } from '@/lib/log';
import { store } from '@/lib/security/rateLimitStore';
import { stashRateLimitHeaders } from '@/lib/security/rateLimitHeaders';
import {
  RATE_LIMIT_POLICIES,
  type PolicyName,
  type RateLimitPolicy,
  type RateLimitWindow,
} from '@/lib/security/rateLimitPolicies';

// ── Key derivation ───────────────────────────────────────────────────────

/** Privacy hash: never store raw IPs or emails in the rate-limit map.
 *  SHA-256 → first 16 hex chars (64 bits — collision-resistant for the
 *  scale + not reversible from the map). */
function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Mask an IP for log lines (the rate-limit map already stores the
 *  hashed form). We never log the raw IP. */
function maskIp(raw: string | null): string {
  if (!raw) return 'unknown';
  // For IPv4 keep the first octet; for IPv6 keep the first hextet.
  if (raw.includes(':')) {
    const first = raw.split(':')[0] || 'x';
    return `${first}:****`;
  }
  const parts = raw.split('.');
  if (parts.length === 4) return `${parts[0]}.***.***.***`;
  return '****';
}

/** Robust IP extraction from a NextRequest. Mirrors the existing
 *  `lib/security/ip.ts` `clientIp()` but works from the request object
 *  directly (no `next/headers()` dependency — avoids a dynamic require). */
export function getClientIp(req: NextRequest): string {
  // X-Forwarded-For: client, proxy1, proxy2 — leftmost is the real client.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xreal = req.headers.get('x-real-ip');
  if (xreal) return xreal.trim();
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  // `NextRequest` exposes `.ip` only in the Edge runtime; in Node-runtime
  // route handlers it's undefined. Loopback fallback is safe for local dev.
  return (req as unknown as { ip?: string }).ip ?? '127.0.0.1';
}

// ── Context passed to applyRateLimit ─────────────────────────────────────

export interface RateLimitContext {
  /** Authenticated user id — required for `userId`/`ip+userId` policies. */
  userId?: string;
  /** Submitted email — required for `ip+email` policies. */
  email?: string;
}

// ── Internal: per-window check ───────────────────────────────────────────

interface CheckResult {
  ok: boolean;
  /** Window the result corresponds to. */
  window: RateLimitWindow;
  /** Post-increment count from the store. */
  count: number;
  /** When the window resets (ms epoch). */
  resetAt: number;
  /** Seconds the caller should wait before retrying (≥1 on failure). */
  retryAfterSeconds: number;
}

async function checkWindow(
  key: string,
  window: RateLimitWindow,
): Promise<CheckResult> {
  const entry = await store.increment(key, window.windowSec);
  const ok = entry.count <= window.max;
  const retryAfterSeconds = ok
    ? 0
    : Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
  return {
    ok,
    window,
    count: entry.count,
    resetAt: entry.resetAt,
    retryAfterSeconds,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/** Build the list of `(keyForLogs, storeKey)` pairs for a policy. We
 *  return TWO entries for compound strategies so the caller iterates
 *  each independently. */
function buildKeys(
  policy: RateLimitPolicy,
  ip: string,
  ctx: RateLimitContext,
): Array<{ id: string; key: string }> {
  const hashedIp = hashKey(ip);
  switch (policy.keyStrategy) {
    case 'ip':
      return [{ id: 'ip', key: `rl:ip:${policy.name}:${hashedIp}` }];

    case 'userId': {
      // Fallback: if the caller forgot to pass userId on a userId-keyed
      // policy, key by IP and emit a structured warning. This shouldn't
      // happen in correctly-written routes — they must call
      // getCurrentUser BEFORE applyRateLimit.
      if (!ctx.userId) {
        log.warn('rate_limit.userid_missing', { policy: policy.name });
        return [{ id: 'ip-fallback', key: `rl:ip:${policy.name}:${hashedIp}` }];
      }
      return [{ id: 'user', key: `rl:user:${policy.name}:${ctx.userId}` }];
    }

    case 'ip+userId': {
      const out: Array<{ id: string; key: string }> = [
        { id: 'ip', key: `rl:ip:${policy.name}:${hashedIp}` },
      ];
      if (ctx.userId) {
        out.push({ id: 'user', key: `rl:user:${policy.name}:${ctx.userId}` });
      }
      return out;
    }

    case 'ip+email': {
      if (!ctx.email) {
        log.warn('rate_limit.email_missing', { policy: policy.name });
        return [{ id: 'ip', key: `rl:ip:${policy.name}:${hashedIp}` }];
      }
      const hashedEmail = hashKey(ctx.email.toLowerCase());
      return [
        { id: 'ip', key: `rl:ip:${policy.name}:${hashedIp}` },
        { id: 'ip+email', key: `rl:ip+email:${policy.name}:${hashedIp}:${hashedEmail}` },
      ];
    }
  }
}

/** THE canonical rate-limit gate. Call once at the top of any route
 *  handler that needs a limit — AFTER any `getCurrentUser` call that
 *  produces the userId.
 *
 *  Throws `RateLimitError` if any window is exceeded. Otherwise
 *  stashes the most-restrictive remaining-budget on the request ALS
 *  so `withErrorHandling` attaches `X-RateLimit-*` headers to the
 *  response. */
export async function applyRateLimit(
  policyName: PolicyName,
  req: NextRequest,
  ctx: RateLimitContext = {},
): Promise<void> {
  const policy = RATE_LIMIT_POLICIES[policyName];
  if (!policy) {
    // Unreachable via the type system; defence-in-depth for callers
    // that bypass TS (e.g. admin tools).
    throw new InternalError(
      `Unknown rate-limit policy "${String(policyName)}"`,
      { code: 'UNKNOWN_RATE_LIMIT_POLICY', context: { policyName } },
    );
  }

  // Test-bypass — runs BEFORE any store mutation so tests don't pollute
  // the in-memory map.
  if (process.env.NODE_ENV === 'test' && policy.skipInTest) return;

  // INTEGRATION-test escape hatch — when an integration test script
  // spawns `next start`, it MAY set `SHOPCORE_DISABLE_RATE_LIMITS=1`
  // in the child env. This bypasses the `global` cap AND any policy
  // marked `skipInTest: true` so test scripts can burst legitimate
  // request patterns past the 120-req/min global ceiling. Policies
  // marked `skipInTest: false` (e.g. `client.error_beacon`) still
  // enforce — that flag is the policy author's signal that the policy
  // must be tested in real conditions.
  //
  // Spec contract: NEVER set this in production. `boot.ts` refuses to
  // start production if it's set. Documented in CONTEXT.md §17 and
  // DEPLOY.md.
  if (process.env.SHOPCORE_DISABLE_RATE_LIMITS === '1' && policy.skipInTest) return;
  if (process.env.SHOPCORE_DISABLE_RATE_LIMITS === '1' && policy.name === 'global') return;

  const ip = getClientIp(req);
  const keyPairs = buildKeys(policy, ip, ctx);

  // For each (key, window) combination, increment + check. We track the
  // tightest remaining-budget across ALL windows to feed the response
  // headers — clients only care about the closest 429.
  let tightest: { limit: number; remaining: number; resetAt: number } | null = null;

  for (const { id, key } of keyPairs) {
    // Widen the iteration type so the per-window `appliesTo` field
    // (optional in `RateLimitWindow`) survives `satisfies`-narrowed
    // policy literals.
    const windows = policy.windows as readonly RateLimitWindow[];
    for (const window of windows) {
      // Per-window `appliesTo` filter — see RateLimitWindow doc. When
      // omitted, the window applies to every key the policy produces.
      if (window.appliesTo && window.appliesTo !== id) continue;
      const result = await checkWindow(key, window);
      if (!result.ok) {
        log.warn('rate_limit.exceeded', {
          policy: policy.name,
          window: window.label,
          keyId: id,
          key: key,                  // already hashed where appropriate
          ip: maskIp(ip),
          userId: ctx.userId,
          retryAfterSeconds: result.retryAfterSeconds,
        });
        throw new RateLimitError(
          `Rate limit ${policy.name} (${window.label}) exceeded`,
          {
            code: 'RATE_LIMITED',
            clientMessage: 'Too many requests. Please try again later.',
            context: {
              policy: policy.name,
              window: window.label,
              retryAfterSeconds: result.retryAfterSeconds,
            },
          },
        );
      }
      log.debug('rate_limit.checked', {
        policy: policy.name,
        window: window.label,
        keyId: id,
        remaining: Math.max(0, window.max - result.count),
        resetAt: result.resetAt,
      });
      const remaining = Math.max(0, window.max - result.count);
      if (!tightest || remaining < tightest.remaining) {
        tightest = { limit: window.max, remaining, resetAt: result.resetAt };
      }
    }
  }

  if (tightest) stashRateLimitHeaders(tightest);
}

// ── Soft check — returns boolean instead of throwing ────────────────────

export interface CheckRateLimitResult {
  ok: boolean;
  /** If !ok, seconds until any of the windows will permit a retry. */
  retryAfterSeconds: number;
  /** Tightest remaining-budget across all checked windows (for callers
   *  that want to display "X attempts remaining"). */
  remaining: number;
  resetAt: number;
}

/** Like `applyRateLimit` but returns a structured result instead of
 *  throwing on exceed. Used by enumeration-safe surfaces (the forgot-
 *  password initiate route) that must respond with a GENERIC 200 even
 *  when the limit fires — throwing would leak which (ip,email) pairs
 *  hit the cap.
 *
 *  Still increments the counter, still emits the `rate_limit.exceeded`
 *  log line. Still respects `skipInTest`. */
export async function checkRateLimit(
  policyName: PolicyName,
  req: NextRequest,
  ctx: RateLimitContext = {},
): Promise<CheckRateLimitResult> {
  const policy = RATE_LIMIT_POLICIES[policyName];
  if (!policy) {
    throw new InternalError(
      `Unknown rate-limit policy "${String(policyName)}"`,
      { code: 'UNKNOWN_RATE_LIMIT_POLICY', context: { policyName } },
    );
  }
  if (process.env.NODE_ENV === 'test' && policy.skipInTest) {
    return { ok: true, retryAfterSeconds: 0, remaining: Number.MAX_SAFE_INTEGER, resetAt: 0 };
  }
  // Integration-test escape hatch — same semantics as applyRateLimit:
  // bypass the global cap + skipInTest-marked policies; non-skipInTest
  // policies (e.g. `client.error_beacon`) still enforce.
  if (process.env.SHOPCORE_DISABLE_RATE_LIMITS === '1'
      && (policy.skipInTest || policy.name === 'global')) {
    return { ok: true, retryAfterSeconds: 0, remaining: Number.MAX_SAFE_INTEGER, resetAt: 0 };
  }
  const ip = getClientIp(req);
  const keyPairs = buildKeys(policy, ip, ctx);
  let worst: CheckResult | null = null;
  for (const { id, key } of keyPairs) {
    const windows = policy.windows as readonly RateLimitWindow[];
    for (const window of windows) {
      if (window.appliesTo && window.appliesTo !== id) continue;
      const r = await checkWindow(key, window);
      if (!r.ok) {
        log.warn('rate_limit.exceeded', {
          policy: policy.name, window: window.label,
          ip: maskIp(ip), userId: ctx.userId,
          retryAfterSeconds: r.retryAfterSeconds, soft: true,
        });
        return {
          ok: false,
          retryAfterSeconds: r.retryAfterSeconds,
          remaining: 0,
          resetAt: r.resetAt,
        };
      }
      if (!worst || (window.max - r.count) < worst.count) worst = r;
    }
  }
  return {
    ok: true,
    retryAfterSeconds: 0,
    remaining: worst ? Math.max(0, worst.window.max - worst.count) : 0,
    resetAt: worst?.resetAt ?? 0,
  };
}

// ── Legacy compatibility shim ────────────────────────────────────────────

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * @deprecated Use `applyRateLimit(policy, req, ctx)` instead. The new
 * API is type-safe (policy name compile-checked), throws RateLimitError
 * for `withErrorHandling` to map, and emits standard response headers.
 *
 * This shim still exists because some legacy call sites might be missed
 * during the migration. The static audit `(A4)` in
 * `scripts/test-rate-limiting.ts` flags any usage of this function
 * outside this file — net effect: the migration is enforced, and once
 * the audit passes this whole shim block can be deleted.
 *
 * Implementation: kept totally separate from the new async `store` so
 * the API stays synchronous (the original signature was sync) and there
 * is no risk of stale-read races between the two surfaces.
 */
interface LegacyBucket { count: number; resetAt: number }
const legacyMap = new Map<string, LegacyBucket>();

export function rateLimit(key: string, max: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  let b = legacyMap.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 1, resetAt: now + windowSeconds * 1000 };
    legacyMap.set(key, b);
  } else {
    b.count += 1;
  }
  if (b.count > max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: Math.max(0, max - b.count), retryAfterSeconds: 0 };
}

/** @deprecated GC is now owned by the InMemoryRateLimitStore singleton. */
export function startRateLimitGc(): void {
  // No-op: the new store starts its own unref'd cleanup interval in its
  // constructor. Kept for backwards-compatible imports.
}
