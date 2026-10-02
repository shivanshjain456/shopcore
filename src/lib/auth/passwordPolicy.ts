/**
 * Shared password-policy validator — Feature #11.
 *
 * Single source of truth used by:
 *   - Registration  (POST /api/auth/signup)
 *   - Password change (POST /api/account/password)
 *   - Future forgot-password / reset-password flow (no modifications needed)
 *   - Client-side strength meter on /signup
 *
 * The same `validatePassword()` function is called server-side and via a
 * "use client"-safe shim in the React component (same TypeScript module —
 * just `import { ... } from '@/lib/auth/passwordPolicy'`). The blocklist
 * is heavy (~13k entries) but the import is tree-shaken on the client
 * since `COMMON_PASSWORDS` is its own module — when the client validator
 * runs the same check, the same set is loaded.
 *
 * SECURITY:
 *   - Server is authoritative. Every rule enforced on the client is
 *     ALSO enforced on the server. The client copy is a UX/feedback layer.
 *   - Plain-text passwords NEVER logged, returned, or persisted. Only
 *     hashed via lib/auth/password.ts:hashPassword.
 *   - Max length 72 — bcrypt truncates at 72, so we reject anything longer
 *     to avoid silent "different password but accepted" footguns.
 */
import { COMMON_PASSWORDS } from './commonPasswords';

export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 72,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
} as const;

/** The exact set the spec asked for; documented for the client UI. */
export const ALLOWED_SYMBOLS = `!@#$%^&*()_+-=[]{}|;':",.<>?/~\``;
const SYMBOL_REGEX = /[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/~`]/;

/** Per-rule status used by the meter UI + the server response. */
export type PasswordRuleId =
  | 'minLength'
  | 'maxLength'
  | 'upper'
  | 'lower'
  | 'digit'
  | 'symbol'
  | 'notCommon'
  | 'notEmailUsername';

export interface PasswordRule {
  id: PasswordRuleId;
  label: string;     // user-facing
  satisfied: boolean;
}

export type PasswordStrengthLevel = 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong';

export interface PasswordValidationResult {
  ok: boolean;
  /** First user-facing error reason (when !ok). Always generic + safe. */
  reason?: string;
  /** Per-rule pass/fail — drives the UI checklist. */
  rules: PasswordRule[];
  /** 0..5 score that maps 1:1 to PasswordStrengthLevel. */
  score: 0 | 1 | 2 | 3 | 4 | 5;
  level: PasswordStrengthLevel;
}

/**
 * Strip trailing/leading digits and trailing punctuation so "Password1!"
 * collapses to "password" for blocklist comparison. This catches the most
 * common variations without false-positives on legitimate strong passwords
 * (which won't be in the blocklist regardless).
 */
function blocklistNormalize(pw: string): string[] {
  const variants = new Set<string>();
  const lower = pw.toLowerCase();
  variants.add(lower);
  // Strip trailing digits
  const m1 = lower.replace(/\d+$/, '');
  if (m1) variants.add(m1);
  // Strip trailing common symbols + digits
  const m2 = lower.replace(/[!@#$%^&*._\-+=]+$/, '').replace(/\d+$/, '');
  if (m2) variants.add(m2);
  // Strip leading + trailing
  const m3 = m2.replace(/^[!@#$%^&*._\-+=]+/, '').replace(/^\d+/, '');
  if (m3) variants.add(m3);
  return [...variants];
}

/** Email local-part extractor — same normalisation as auth/emailPolicy. */
function emailUsername(email: string | undefined | null): string {
  if (typeof email !== 'string') return '';
  const e = email.trim().toLowerCase();
  const at = e.indexOf('@');
  return at > 0 ? e.slice(0, at) : '';
}

/**
 * Score 0..5 from satisfied-rule count + length bonus.
 *
 * Mapping (per spec):
 *   0–1 → Weak
 *   2   → Fair
 *   3   → Good
 *   4   → Strong
 *   5+  → Very Strong
 *
 * We compute on the SAME information server + client so the meter never
 * shows a different verdict than the submission outcome.
 */
function scoreLevel(rules: PasswordRule[], pw: string): { score: 0|1|2|3|4|5; level: PasswordStrengthLevel } {
  // Base score: count of CHARACTER-CLASS rules satisfied (upper / lower /
  // digit / symbol / notEmailUsername / notCommon). Length contributes via
  // the bonus below.
  const classBased = rules.filter((r) =>
    r.id === 'upper' || r.id === 'lower' || r.id === 'digit' ||
    r.id === 'symbol' || r.id === 'notCommon' || r.id === 'notEmailUsername',
  );
  let s = classBased.filter((r) => r.satisfied).length;
  // Length bonus: +1 for ≥12 chars (encourages length over complexity).
  if (pw.length >= 12) s += 1;

  // ── Honest meter rule (Feature #11):
  //    The meter MUST NOT exceed "Fair" (score 2) when the password fails
  //    ANY required policy rule. Otherwise a missing-digit or missing-symbol
  //    password could read "Very Strong" while the form still rejects it,
  //    which is exactly the misleading-UX trap the spec asked us to avoid.
  //    `ok` is computed in the caller (`validatePassword`) — we re-derive
  //    the same condition here to keep this function pure.
  const allRequiredOk = rules.every((r) => r.satisfied);
  if (!allRequiredOk) s = Math.min(s, 2);

  if (s < 0) s = 0;
  if (s > 5) s = 5;
  // Floor to 0 when even the min-length isn't met.
  if (pw.length < PASSWORD_POLICY.minLength) s = 0;

  const levels: PasswordStrengthLevel[] = ['Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
  return { score: s as 0|1|2|3|4|5, level: levels[s] };
}

export interface ValidateOptions {
  /** When set, the password may not contain the email's username portion
   *  (case-insensitive substring match). Recommended for signup + change. */
  email?: string | null;
}

/**
 * Pure, side-effect-free validator. Returns the full rule table + score
 * even when ok===false so the UI can render the checklist consistently.
 */
export function validatePassword(pw: unknown, opts: ValidateOptions = {}): PasswordValidationResult {
  // First-pass nullable guard. We return a fully-shaped result so callers
  // never have to special-case "undefined".
  const password = typeof pw === 'string' ? pw : '';

  // Build the per-rule table FIRST so the UI can render it even on partial
  // input (e.g. user typed "pa" and we want the checklist to update).
  //
  // "Does not contain your email name" — we split the username on common
  // separators (._-+) so an email like `katrina_1780@gmail.com` exposes
  // 'katrina' as a meaningful name fragment to filter against. We only
  // consider fragments ≥3 chars to avoid false-positives on short
  // initials like 'jo' or 'a'.
  const username = emailUsername(opts.email);
  const fragments = username.split(/[._\-+]+/).filter((f) => f.length >= 3);
  if (username.length >= 3) fragments.push(username);
  const lowerPw = password.toLowerCase();
  const containsUsername = fragments.some((frag) => lowerPw.includes(frag));

  const variants = blocklistNormalize(password);
  const isCommon = variants.some((v) => COMMON_PASSWORDS.has(v));

  const rules: PasswordRule[] = [
    { id: 'minLength',         label: `At least ${PASSWORD_POLICY.minLength} characters`, satisfied: password.length >= PASSWORD_POLICY.minLength },
    { id: 'maxLength',         label: `At most ${PASSWORD_POLICY.maxLength} characters`,  satisfied: password.length > 0 && password.length <= PASSWORD_POLICY.maxLength },
    { id: 'upper',             label: 'Contains an uppercase letter',  satisfied: /[A-Z]/.test(password) },
    { id: 'lower',             label: 'Contains a lowercase letter',   satisfied: /[a-z]/.test(password) },
    { id: 'digit',             label: 'Contains a digit (0–9)',         satisfied: /[0-9]/.test(password) },
    { id: 'symbol',            label: 'Contains a special character',   satisfied: SYMBOL_REGEX.test(password) },
    { id: 'notCommon',         label: 'Not a common / breached password', satisfied: !isCommon && password.length > 0 },
    { id: 'notEmailUsername',  label: 'Does not contain your email name', satisfied: !containsUsername },
  ];

  // Decide ok + the first failed-reason. Order matters for the user-facing
  // error message: pick the most ACTIONABLE failure first.
  let reason: string | undefined;
  if (!password) reason = 'Password is required.';
  else if (password.length < PASSWORD_POLICY.minLength) reason = `Password must be at least ${PASSWORD_POLICY.minLength} characters.`;
  else if (password.length > PASSWORD_POLICY.maxLength) reason = `Password must be at most ${PASSWORD_POLICY.maxLength} characters.`;
  else if (!rules.find((r) => r.id === 'upper')!.satisfied)  reason = 'Password must contain an uppercase letter.';
  else if (!rules.find((r) => r.id === 'lower')!.satisfied)  reason = 'Password must contain a lowercase letter.';
  else if (!rules.find((r) => r.id === 'digit')!.satisfied)  reason = 'Password must contain a digit.';
  else if (!rules.find((r) => r.id === 'symbol')!.satisfied) reason = 'Password must contain a special character.';
  else if (!rules.find((r) => r.id === 'notCommon')!.satisfied)        reason = 'This password is too common. Please choose something less guessable.';
  else if (!rules.find((r) => r.id === 'notEmailUsername')!.satisfied) reason = 'Password cannot contain your email name.';

  const { score, level } = scoreLevel(rules, password);
  return {
    ok: !reason,
    reason,
    rules,
    score,
    level,
  };
}

/**
 * Strict assertion wrapper used by server routes. Throws an `Error` with
 * the generic user-facing message; the route handler catches it and
 * returns the existing `jsonError(message, 400)` shape.
 */
export function assertPasswordOk(pw: unknown, opts?: ValidateOptions): void {
  const r = validatePassword(pw, opts);
  if (!r.ok) {
    const err = new Error(r.reason ?? 'Password does not meet the policy.');
    (err as Error & { status?: number; code?: string }).status = 400;
    (err as Error & { status?: number; code?: string }).code = 'PASSWORD_POLICY';
    throw err;
  }
}
