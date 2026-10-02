/**
 * Rate-limit storage abstraction.
 *
 * The interface intentionally mirrors what a Redis-backed implementation
 * would offer (INCR + EXPIRE under the hood), so swapping out
 * `InMemoryRateLimitStore` for a Redis adapter requires zero changes
 * at the call site. For our single-VPS / single-process / ≤500-users
 * target, the in-memory implementation is sufficient.
 *
 * Algorithm note: we implement a **fixed window** counter (not sliding).
 * Each key has one counter that resets when its `resetAt` passes. This
 * is well-known to allow a burst of up to `2 * max` requests at the
 * window boundary; we accept that for the scale target.
 * If you ever replace this with a true sliding window, document the
 * trade-off here.
 */
import { InternalError } from '@/lib/errors';

export interface RateLimitEntry {
  /** Current count of hits in the active window. */
  count: number;
  /** Unix epoch millis when this window expires and the counter resets. */
  resetAt: number;
}

export interface RateLimitStore {
  /** Atomically increment the counter at `key`. If the window has
   *  expired (`resetAt < now`), reset to `{ count: 1, resetAt: now + windowSec*1000 }`.
   *  Returns the post-increment state.
   *
   *  Throws only for programming errors (windowSec <= 0). */
  increment(key: string, windowSec: number): Promise<RateLimitEntry>;

  /** Read the current count + resetAt at `key` WITHOUT incrementing.
   *  Returns `{ remaining: max, resetAt: 0 }` if the key is absent. */
  remaining(key: string, max: number): Promise<{ remaining: number; resetAt: number }>;

  /** Read the raw entry (count + resetAt) without incrementing. Returns
   *  null when the key is absent or its window has expired. Used by the
   *  admin inspection endpoint to surface the absolute count cleanly. */
  peek(key: string): Promise<RateLimitEntry | null>;

  /** Delete a key — used by the admin reset endpoint. */
  reset(key: string): Promise<void>;

  /** Glob-style listing of active keys (admin inspection only). */
  keys(pattern: string): Promise<string[]>;

  /** Current count of live entries — admin/inspection convenience. */
  size(): number;
}

// ── In-memory implementation ──────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, RateLimitEntry>();
  // Hold the timer so we can clear it from tests; `unref()` ensures it
  // does NOT keep the Node event loop alive (spawned test servers must
  // exit cleanly when SIGKILL'd).
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    if (typeof setInterval === 'function') {
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      // `.unref?.()` for environments where unref isn't available (Edge).
      this.cleanupTimer.unref?.();
    }
  }

  async increment(key: string, windowSec: number): Promise<RateLimitEntry> {
    if (!Number.isFinite(windowSec) || windowSec <= 0) {
      throw new InternalError(
        `InMemoryRateLimitStore.increment: invalid windowSec=${windowSec}`,
        { code: 'INVALID_RATE_LIMIT_WINDOW', context: { key, windowSec } },
      );
    }
    const now = Date.now();
    const cur = this.map.get(key);
    if (!cur || cur.resetAt < now) {
      const fresh: RateLimitEntry = { count: 1, resetAt: now + windowSec * 1000 };
      this.map.set(key, fresh);
      return fresh;
    }
    cur.count += 1;
    return cur;
  }

  async remaining(key: string, max: number): Promise<{ remaining: number; resetAt: number }> {
    const cur = this.map.get(key);
    if (!cur || cur.resetAt < Date.now()) {
      return { remaining: max, resetAt: 0 };
    }
    return { remaining: Math.max(0, max - cur.count), resetAt: cur.resetAt };
  }

  async peek(key: string): Promise<RateLimitEntry | null> {
    const cur = this.map.get(key);
    if (!cur || cur.resetAt < Date.now()) return null;
    // Defensive copy — never hand callers a live reference into the map.
    return { count: cur.count, resetAt: cur.resetAt };
  }

  async reset(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    // Simple glob: `*` matches any run of chars, everything else literal.
    const re = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
    const out: string[] = [];
    for (const k of this.map.keys()) if (re.test(k)) out.push(k);
    return out;
  }

  size(): number {
    return this.map.size;
  }

  /** Internal: drop expired entries. Called by the cleanup interval and
   *  exposed for tests that want to run cleanup synchronously. */
  cleanup(): void {
    const now = Date.now();
    for (const [k, v] of this.map.entries()) {
      if (v.resetAt < now) this.map.delete(k);
    }
  }

  /** Test-only — wipes the map. Production code should use `reset(key)`. */
  _wipeForTests(): void {
    this.map.clear();
  }

  /** Test-only — inject a raw entry to simulate state (e.g. expired window). */
  _setForTests(key: string, entry: RateLimitEntry): void {
    this.map.set(key, entry);
  }

  /** Test-only — stop the cleanup interval so the process can exit. */
  _stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Singleton (process-local) ─────────────────────────────────────────────
//
// Held on `globalThis` so Next.js HMR doesn't multiply instances in dev —
// same pattern as the Prisma singleton.
//
// To migrate to Redis: replace the assignment below with a Redis-backed
// implementation of `RateLimitStore`. No call site needs to change.

interface GlobalShape { __rateLimitStore__?: RateLimitStore }
const g = globalThis as unknown as GlobalShape;

export const store: RateLimitStore = g.__rateLimitStore__ ?? new InMemoryRateLimitStore();
if (!g.__rateLimitStore__) g.__rateLimitStore__ = store;
