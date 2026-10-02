/**
 * Shared email-policy validator — Feature #10.
 *
 * ── DESIGN ────────────────────────────────────────────────────────────────
 * Default-deny strict allowlist. We reject every email that isn't from an
 * explicitly trusted personal-mailbox provider, AND we reject local-part
 * patterns that abuse aliasing / dot-obfuscation / fragmentation to mint
 * many "different" addresses from the same physical mailbox.
 *
 * The rules are owned HERE, the configuration (allowlist) lives in
 * `lib/config.ts` so additional domains can be added without touching this
 * file. There is exactly ONE entry point — `assertEmailAllowed()` — and
 * every signup/login/OTP route MUST call it before any DB work.
 *
 * User-facing error: a single generic message. We deliberately do NOT
 * expose WHY an email was rejected — that would help abusers iterate.
 * The `code` field in the result is for server-side logging only.
 * ──────────────────────────────────────────────────────────────────────── */
// NB: we read `process.env.NODE_ENV` directly (not `env.NODE_ENV` from
// `@/lib/config`) so the value is checked at CALL time, not at module-load
// time. This matters for tests that toggle NODE_ENV per assertion.


/**
 * Trusted personal-mailbox providers. EXACT-match — `mail.gmail.com` is NOT
 * `gmail.com`, neither is `gmail.co`. `googlemail.com` is deliberately NOT
 * here even though it resolves to the same Google mailbox — admitting both
 * would create a duplicate-account-creation path (see Gmail canonicalization
 * policy in the spec).
 *
 * Keep this list short and personal-only. Corporate / school / government /
 * disposable providers MUST stay out.
 */
export const TRUSTED_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'zoho.com',
  'zohomail.com',
] as const;

/** Providers we apply the strict Gmail-style dot-obfuscation rules to.
 *  Gmail famously ignores dots in the local part, so dot-density attacks
 *  are unique to it. Other providers treat dots as significant. */
const GMAIL_FAMILY: ReadonlySet<string> = new Set(['gmail.com']);

export type EmailRejectCode =
  | 'EMPTY'
  | 'BAD_SYNTAX'
  | 'DOMAIN_NOT_ALLOWED'
  | 'PLUS_ALIAS'
  | 'GMAIL_DOT_OBFUSCATION'
  | 'FRAG_TOO_MANY_SEGMENTS'
  | 'FRAG_TOO_MANY_SHORT'
  | 'FRAG_CONSECUTIVE_SHORT'
  | 'FRAG_HIGH_DOT_DENSITY'
  | 'FRAG_TOO_MANY_SINGLE_CHARS';

export interface EmailCheckResult {
  ok: boolean;
  /** Lower-cased, trimmed canonical form. Always present even when ok=false. */
  normalized: string;
  /** Internal reject code — never surface to end users. */
  code?: EmailRejectCode;
  /** Brief internal reason — for server logs only. */
  internalReason?: string;
}

/**
 * The ONLY error string shown to end users when policy rejects an email.
 * Deliberately generic — exposing the specific rule that fired would let
 * abusers iterate (e.g. "ok, fewer dots next time").
 */
export const EMAIL_POLICY_USER_MESSAGE =
  'Please use a valid personal email address from a supported provider.';

/**
 * Returns the canonical lower-cased email for any input. Used by callers
 * that want a normalised value even when validation will short-circuit
 * later (e.g. privacy-preserving signup that says "if this email is new …").
 */
export function normalizeEmail(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase();
}

/** Very-light syntactic guard — we still defer the strict regex to Zod. */
function basicSyntaxOk(email: string): boolean {
  // <local>@<domain>; both non-empty; no whitespace; one '@'.
  if (!email || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return false;
  // domain must have at least one dot, no leading/trailing dot or hyphen.
  if (!domain.includes('.')) return false;
  if (/(^[.-])|([.-]$)/.test(domain)) return false;
  return true;
}

interface PolicyOptions {
  /** Whitelist domains exclusively for tests. Bound to non-production at
   *  the call sites. NEVER set this from a user-controlled value. */
  extraAllowedDomains?: readonly string[];
}

/**
 * Core synchronous policy check. Returns a structured result; the calling
 * route is responsible for either throwing or returning the generic
 * user-facing message. SAFE to call from anywhere — no DB, no I/O.
 */
export function checkEmailPolicy(input: unknown, opts?: PolicyOptions): EmailCheckResult {
  const normalized = normalizeEmail(input);

  if (!normalized) {
    return { ok: false, normalized, code: 'EMPTY', internalReason: 'empty email' };
  }
  if (!basicSyntaxOk(normalized)) {
    return { ok: false, normalized, code: 'BAD_SYNTAX', internalReason: 'syntax' };
  }

  const at = normalized.indexOf('@');
  const localPart = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);

  // ── Rule 1 — Strict provider allowlist (exact match, no suffix match) ──
  const allowlist = new Set<string>([
    ...TRUSTED_EMAIL_DOMAINS,
    ...(opts?.extraAllowedDomains ?? []),
  ]);
  if (!allowlist.has(domain)) {
    return {
      ok: false, normalized, code: 'DOMAIN_NOT_ALLOWED',
      internalReason: `domain "${domain}" not in allowlist`,
    };
  }

  // ── Rule 2 — Block plus addressing (every provider) ────────────────────
  if (localPart.includes('+')) {
    return { ok: false, normalized, code: 'PLUS_ALIAS', internalReason: 'local part contains +' };
  }

  // From here on rules apply ONLY to Gmail-family providers (gmail.com).
  if (GMAIL_FAMILY.has(domain)) {
    const dotCount = (localPart.match(/\./g) ?? []).length;

    // ── Rule 3 — Gmail dot obfuscation: 2 or more dots ──────────────────
    if (dotCount >= 2) {
      return {
        ok: false, normalized, code: 'GMAIL_DOT_OBFUSCATION',
        internalReason: `dotCount=${dotCount} (>=2) on gmail.com`,
      };
    }

    // ── Rule 4 — Suspicious fragmentation (still useful as belt+braces)
    //              even though rule 3 above already catches dotCount>=2 cases
    //              the segment-based rules will fire for dotCount<2 patterns
    //              when single-character or short segments are abused.
    const segments = localPart.split('.');
    const shortSegments = segments.filter((s) => s.length <= 2).length;
    const singleCharSegments = segments.filter((s) => s.length === 1).length;
    // Condition A — excessive fragmentation
    if (segments.length >= 5) {
      return {
        ok: false, normalized, code: 'FRAG_TOO_MANY_SEGMENTS',
        internalReason: `segments=${segments.length} (>=5)`,
      };
    }
    // Condition B — too many short segments
    if (shortSegments >= 3) {
      return {
        ok: false, normalized, code: 'FRAG_TOO_MANY_SHORT',
        internalReason: `shortSegments=${shortSegments} (>=3)`,
      };
    }
    // Condition C — consecutive short segments
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].length <= 2 && segments[i - 1].length <= 2) {
        return {
          ok: false, normalized, code: 'FRAG_CONSECUTIVE_SHORT',
          internalReason: `consecutive short segments at idx ${i - 1},${i}`,
        };
      }
    }
    // Condition D — high dot density
    const dotDensity = dotCount / localPart.length;
    if (dotDensity > 0.20) {
      return {
        ok: false, normalized, code: 'FRAG_HIGH_DOT_DENSITY',
        internalReason: `dotDensity=${dotDensity.toFixed(3)} (>0.20)`,
      };
    }
    // Condition E — 2 or more single-character segments
    if (singleCharSegments >= 2) {
      return {
        ok: false, normalized, code: 'FRAG_TOO_MANY_SINGLE_CHARS',
        internalReason: `singleChar=${singleCharSegments} (>=2)`,
      };
    }
  }

  return { ok: true, normalized };
}

/**
 * Asserting wrapper used by route handlers. Throws an `EmailPolicyError`
 * whose `.toJsonError()` shape matches the project's `jsonError(...)`
 * conventions: a generic, non-leaky user-facing message + a 400 status.
 *
 * Routes catch this with the existing `handleError` machinery.
 */
export function assertEmailAllowed(input: unknown, opts?: PolicyOptions): string {
  const r = checkEmailPolicy(input, opts);
  if (!r.ok) throw new EmailPolicyError(r);
  return r.normalized;
}

export class EmailPolicyError extends Error {
  status = 400;
  public readonly code: EmailRejectCode;
  public readonly internalReason: string | undefined;
  public readonly normalized: string;
  constructor(result: EmailCheckResult) {
    super(EMAIL_POLICY_USER_MESSAGE);
    this.name = 'EmailPolicyError';
    this.code = (result.code ?? 'BAD_SYNTAX');
    this.internalReason = result.internalReason;
    this.normalized = result.normalized;
  }
}

/**
 * Build the dev/test-mode `extraAllowedDomains`. Bound to NODE_ENV so the
 * production build NEVER enables them. Test suites consistently use
 * `*@shopcore.test`; the bootstrap admin uses `*@yourdomain.in` and is
 * created via the seed script, never the HTTP signup, so it doesn't need
 * an exemption.
 */
/**
 * Returns extra allowlist domains for non-production environments.
 *
 * We read `SHOPCORE_ALLOW_TEST_EMAILS` and ALSO honour NODE_ENV != 'production'
 * (Next.js/webpack statically replaces `process.env.NODE_ENV` at build time,
 * so we use `process.env[...]` bracket access to defeat that optimisation
 * for the SHOPCORE_ALLOW_TEST_EMAILS path — the env var is therefore checked
 * at server runtime, NOT bundle build time).
 *
 * In production builds, BOTH conditions must be false → returns [].
 * In tests, the test runner spawns `next start` with both flags set.
 */
export function devOnlyExtraAllowedDomains(): readonly string[] {
  // Use bracket access so webpack/SWC can't inline-replace these values at
  // build time. They get read on every request, from the running server's
  // actual environment.
  const allowTest = process.env['SHOPCORE_ALLOW_TEST_EMAILS'];
  const nodeEnv   = process.env['NODE_ENV'];
  if (allowTest === '1' || allowTest === 'true') return ['shopcore.test'];
  if (nodeEnv && nodeEnv !== 'production')      return ['shopcore.test'];
  return [];
}
