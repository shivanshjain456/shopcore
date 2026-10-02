/**
 * Rate-limit policy registry — the ONE place every limit number lives.
 *
 * Adding a new endpoint? Add a policy here. Need to change a limit? Edit
 * the policy here and redeploy. Want to know "what's our login rate
 * limit?" — answer is in this file in under 10 seconds.
 *
 * Rule (audit-enforced): no rate-limit number may appear anywhere else
 * in `src/` outside this file. `scripts/test-rate-limiting.ts (A1)` /
 * `(A3)` scans for offenders and fails the build.
 *
 * Why this file is not env-driven:
 *
 *   Rate limits are operational configuration that should be reviewed
 *   alongside code and shipped via deployment, not hot-changed via
 *   env vars in a running system. A rate limit reduction is a security
 *   posture change; a rate limit increase is a load decision — both
 *   deserve a PR.
 *
 * Two-window policies (burst + sustained):
 *
 *   `auth.login` for example has 5 attempts in 15 min (burst) AND
 *   20 attempts in 24 hours (sustained). BOTH windows are checked on
 *   every request; exceeding either triggers the limit. Both are
 *   keyed identically (e.g. by IP) — the windows just have different
 *   `max` / `windowSec` pairs.
 *
 * Compound key strategies:
 *
 *   `ip+userId` and `ip+email` policies build TWO independent keys
 *   per request and check each set of windows separately. See
 *   `applyRateLimit` for the implementation detail.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type KeyStrategy =
  | 'ip'
  | 'userId'
  | 'ip+userId'
  | 'ip+email';

export interface RateLimitWindow {
  /** Max hits allowed in the window. */
  max: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Human-readable label — surfaces in the log line and the
   *  RateLimitError context so ops can see which window blew. */
  label: 'burst' | 'sustained' | 'hourly' | 'daily' | 'minute' | 'window';
  /** Optional override: apply this window to ONLY one of the policy's
   *  key strategies. When omitted, the window is applied to EVERY key
   *  the policy produces.
   *
   *  Example: `auth.phone.verify` has `keyStrategy: 'ip+userId'` and:
   *    - one window `5/15min` with `appliesTo: 'ip'`     (IP burst cap)
   *    - one window `3/60min` with `appliesTo: 'user'`   (per-user cap)
   *  Without this override, BOTH windows would apply to BOTH keys, which
   *  would mean an IP could only do 3 phone-verifies/hour across ALL
   *  users — wrong for a NAT'd household. */
  appliesTo?: 'ip' | 'user' | 'ip+email' | 'ip-fallback';
}

export interface RateLimitPolicy {
  /** Human-readable policy id, also the registry key. */
  name: string;
  /** How to derive the rate-limit bucket key for each request. */
  keyStrategy: KeyStrategy;
  /** One or more windows — exceeding any one triggers the limit. The
   *  type forces at least one window via tuple-rest. */
  windows: [RateLimitWindow, ...RateLimitWindow[]];
  /** When true and `NODE_ENV === 'test'`, `applyRateLimit` returns
   *  immediately without incrementing or throwing. Used for ~every
   *  policy so integration tests don't trip themselves up. The
   *  `global` policy is intentionally `false`. */
  skipInTest: boolean;
}

// ── Window helpers (purely for readability of the registry below) ────────

const W = {
  /** 5 hits per 15 minutes — typical short burst window. */
  burst: (max: number, minutes: number): RateLimitWindow => ({
    max, windowSec: minutes * 60, label: 'burst',
  }),
  hour: (max: number): RateLimitWindow => ({
    max, windowSec: 60 * 60, label: 'hourly',
  }),
  day: (max: number): RateLimitWindow => ({
    max, windowSec: 24 * 60 * 60, label: 'daily',
  }),
  minute: (max: number, minutes: number = 1): RateLimitWindow => ({
    max, windowSec: minutes * 60, label: 'minute',
  }),
  sustained: (max: number, minutes: number): RateLimitWindow => ({
    max, windowSec: minutes * 60, label: 'sustained',
  }),
};

// ── THE REGISTRY ─────────────────────────────────────────────────────────
//
// Ordered roughly by where the limit fires in the request lifecycle:
//   global → auth → account → checkout → catalog/admin.

export const RATE_LIMIT_POLICIES = {
  // ── Global (every API request) ─────────────────────────────────────────
  // Applied as the FIRST step of withErrorHandling. Always active —
  // skipInTest must remain false. 120 req/min/IP at our scale comfortably
  // covers a legit user's burst (e.g. cart-validate fires on every
  // quantity change) without leaving the door open for scrapers.
  'global': {
    name: 'global',
    keyStrategy: 'ip',
    windows: [W.minute(120, 1)],
    skipInTest: false,
  },

  // ── Auth — credential surfaces ─────────────────────────────────────────
  'auth.login': {
    name: 'auth.login',
    keyStrategy: 'ip',
    windows: [W.burst(5, 15), W.day(20)],
    skipInTest: true,
  },
  // Per-email companion to auth.login — protects ONE account from a
  // distributed brute-force across many IPs. We use `ip+email` strategy
  // but pin the window to the `ip+email` key only (the IP-only side is
  // already covered by `auth.login`); pinning prevents this policy from
  // double-counting the IP bucket.
  'auth.login.email': {
    name: 'auth.login.email',
    keyStrategy: 'ip+email',
    windows: [{ ...W.burst(5, 15), appliesTo: 'ip+email' }],
    skipInTest: true,
  },
  'auth.signup': {
    name: 'auth.signup',
    keyStrategy: 'ip',
    windows: [W.hour(5)],
    skipInTest: true,
  },
  'auth.admin.login': {
    name: 'auth.admin.login',
    // Admin login is the HIGHEST-value credential surface — tighter than
    // customer login. 3 attempts / 15 minutes is the spec value.
    keyStrategy: 'ip',
    windows: [W.burst(3, 15)],
    skipInTest: true,
  },

  // ── Auth — OTP surfaces ────────────────────────────────────────────────
  'auth.otp.verify': {
    name: 'auth.otp.verify',
    // IP-keyed: the per-OTP attempt count is independently enforced by
    // `verifyOtp` (decrements on each wrong code), so this layer just
    // caps total verify-route hits per IP. Generous because legitimate
    // form retries (paste wrong code → retype) happen.
    keyStrategy: 'ip',
    windows: [{ max: 30, windowSec: 10 * 60, label: 'window' }],
    skipInTest: true,
  },
  'auth.otp.resend': {
    name: 'auth.otp.resend',
    keyStrategy: 'ip',
    windows: [W.hour(3)],
    skipInTest: true,
  },
  'auth.check_email': {
    name: 'auth.check_email',
    // Enumeration mitigator — caps how fast an attacker can probe
    // whether emails exist via the signup-availability endpoint.
    // `skipInTest: false` because `test:account-policy (xii)` asserts
    // the policy actually fires under burst — keeping it active in
    // test mode is the only way to verify enumeration mitigation.
    keyStrategy: 'ip',
    windows: [W.hour(10)],
    skipInTest: false,
  },

  // ── Auth — Phone Verification (Item 2) ─────────────────────────────────
  'auth.phone.verify': {
    name: 'auth.phone.verify',
    keyStrategy: 'ip+userId',
    // IP burst (5/15min) defends against many-users-from-one-IP credential
    // stuffing. Per-user hourly (3/hour) defends against a single account
    // being hammered from many IPs. `appliesTo` keeps each window pinned
    // to its intended key so a NAT'd household doesn't share one 3/hour
    // bucket across every member.
    windows: [
      { ...W.burst(5, 15),  appliesTo: 'ip' },
      { ...W.hour(3),       appliesTo: 'user' },
    ],
    skipInTest: true,
  },
  'auth.phone.resend': {
    name: 'auth.phone.resend',
    // `skipInTest: false` so `test:phone-verification (I7)` can assert
    // 4th call returns 429 — small enough cap (3/hour) that no other
    // test is harmed by the policy being active.
    keyStrategy: 'ip',
    windows: [W.hour(3)],
    skipInTest: false,
  },

  // ── Auth — Forgot password ─────────────────────────────────────────────
  // The IP cap is the hard 429-firing layer. The route ALSO does a
  // SOFT per-(IP+email) check using `auth.forgot_password.per_email`
  // below — that policy is consumed via the store directly, NOT
  // applyRateLimit, because exceeding it returns a generic 200 (NOT
  // a 429) to avoid leaking which addresses have an account.
  'auth.forgot_password.initiate': {
    name: 'auth.forgot_password.initiate',
    keyStrategy: 'ip',
    windows: [W.hour(10)],
    skipInTest: true,
  },
  'auth.forgot_password.per_email': {
    name: 'auth.forgot_password.per_email',
    keyStrategy: 'ip+email',
    windows: [W.hour(3)],
    skipInTest: true,
  },
  'auth.forgot_password.verify': {
    name: 'auth.forgot_password.verify',
    keyStrategy: 'ip',
    windows: [W.burst(5, 15)],
    skipInTest: true,
  },
  'auth.forgot_password.resend': {
    name: 'auth.forgot_password.resend',
    keyStrategy: 'ip',
    windows: [W.hour(10)],
    skipInTest: true,
  },
  'auth.forgot_password.reset': {
    name: 'auth.forgot_password.reset',
    keyStrategy: 'ip',
    windows: [W.burst(5, 15)],
    skipInTest: true,
  },

  // ── Auth — session refresh ─────────────────────────────────────────────
  'auth.refresh': {
    name: 'auth.refresh',
    keyStrategy: 'ip',
    windows: [W.minute(30, 1)],
    skipInTest: true,
  },

  // ── Account self-service ──────────────────────────────────────────────
  'account.phone_update': {
    name: 'account.phone_update',
    keyStrategy: 'userId',
    windows: [W.hour(3)],
    skipInTest: true,
  },
  'account.password': {
    name: 'account.password',
    keyStrategy: 'userId',
    windows: [W.hour(5)],
    skipInTest: true,
  },
  'account.profile': {
    name: 'account.profile',
    keyStrategy: 'userId',
    windows: [W.hour(10)],
    skipInTest: true,
  },
  'account.upload': {
    name: 'account.upload',
    keyStrategy: 'userId',
    windows: [{ max: 40, windowSec: 10 * 60, label: 'window' }],
    skipInTest: true,
  },

  // ── Checkout ───────────────────────────────────────────────────────────
  'checkout.place_order': {
    name: 'checkout.place_order',
    keyStrategy: 'userId',
    // 6 / minute matches the previous ad-hoc cap and prevents both
    // accidental double-submits and intentional flooding. We do NOT
    // ship the day window for place-order — legitimate B2B users may
    // place many orders during a session.
    windows: [W.minute(6, 1)],
    skipInTest: true,
  },
  'checkout.upload_receipt': {
    name: 'checkout.upload_receipt',
    keyStrategy: 'userId',
    windows: [{ max: 20, windowSec: 10 * 60, label: 'window' }],
    skipInTest: true,
  },
  'checkout.express': {
    name: 'checkout.express',
    keyStrategy: 'userId',
    windows: [W.minute(30, 1)],
    skipInTest: true,
  },

  // ── Catalog + storefront ───────────────────────────────────────────────
  'pincode.lookup': {
    name: 'pincode.lookup',
    // `skipInTest: false` so `test:pincode (vi)` can assert the policy
    // actually fires under burst — 60/min is comfortable enough not to
    // affect other suites.
    keyStrategy: 'ip',
    windows: [W.minute(60, 1)],
    skipInTest: false,
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  'admin.uploads': {
    name: 'admin.uploads',
    keyStrategy: 'userId',
    windows: [{ max: 40, windowSec: 10 * 60, label: 'window' }],
    skipInTest: true,
  },

  // ── Misc ───────────────────────────────────────────────────────────────
  'client.error_beacon': {
    name: 'client.error_beacon',
    keyStrategy: 'ip',
    windows: [W.minute(30, 1)],
    skipInTest: false,  // we WANT the beacon limit live in tests too
  },

  // ── Public contact form (Item 13) ──────────────────────────────────────
  // /api/contact is a PUBLIC endpoint (anonymous OK), so the per-IP limit
  // is the only meaningful brake against spam beyond CSRF + the honeypot.
  // 3/hour/IP matches the spec's deliberately-tight quota: a real user
  // never needs more than one form submission per visit; anything higher
  // is bot traffic or an enraged customer who'd be better served via the
  // displayed support email anyway.
  'contact.form': {
    name: 'contact.form',
    keyStrategy: 'ip',
    windows: [W.hour(3)],
    // skipInTest: the integration suite specifically asserts the 4th
    // submission gets 429, so we must NOT skip in test.
    skipInTest: false,
  },
  // ── Item 14 — Compare ───────────────────────────────────────────
  //
  //   compare.add  fires on every POST /api/compare. Anonymous users
  //                key by IP (no userId yet); authed by userId. 20/hr
  //                is generous — typical session adds <5 products to
  //                compare. The integration suite asserts the policy
  //                is registered but doesn't drive it to 429, so
  //                skipInTest stays true.
  //   compare.sync is the login-merge endpoint. 10/hr/userId is
  //                plenty: it fires once per login. Higher rate
  //                would indicate a misbehaving client polling.
  'compare.add': {
    name: 'compare.add',
    keyStrategy: 'ip+userId',
    windows: [
      { ...W.hour(20), appliesTo: 'user' },
      { ...W.hour(60), appliesTo: 'ip'   },
    ],
    skipInTest: true,
  },
  'compare.sync': {
    name: 'compare.sync',
    keyStrategy: 'userId',
    windows: [W.hour(10)],
    skipInTest: true,
  },

  // ── Item 18 Phase 2 — Newsletter subscription ─────────────────────────
  //
  //   `newsletter.subscribe` is a PUBLIC endpoint (anonymous OK), so
  //   the per-IP limit is the only meaningful brake against abuse beyond
  //   CSRF. 5/hour/IP is tight: a real user never needs to subscribe
  //   more than once. Higher traffic is enumeration of which addresses
  //   already have an account — the response is deliberately uniform to
  //   prevent that signal leaking, but the limit caps how fast someone
  //   can probe regardless. `skipInTest: false` so the integration suite
  //   can assert the 6th submission gets a 429.
  'newsletter.subscribe': {
    name: 'newsletter.subscribe',
    keyStrategy: 'ip',
    windows: [W.hour(5)],
    skipInTest: false,
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type PolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** Compile-time-safe lookup; throws an InternalError at runtime if
 *  passed a name from `unknown` (e.g. an admin tool). */
export function getPolicy(name: PolicyName): RateLimitPolicy {
  return RATE_LIMIT_POLICIES[name];
}
