/**
 * Phone-number utilities — single source of truth for ShopCore (Item 9).
 *
 * All exports here are PURE:
 *   - `normalisePhone(raw)`    — string → E.164 `+91XXXXXXXXXX` (or null).
 *                                Never throws (component calls it on every
 *                                keystroke). Use `phoneSchema` on the server
 *                                for the throw-on-invalid contract.
 *   - `isValidIndianMobile(s)` — boolean predicate over normalisePhone.
 *   - `formatPhone(e164)`      — display-only `+91 98765 43210`. Defensive:
 *                                invalid input echoes through unchanged.
 *   - `maskPhone(e164)`        — mask-for-display `+91 ••••• ••1234`.
 *                                Re-exported from `lib/auth/phoneVerification.ts`
 *                                via this module to keep a single import path.
 *
 * The legacy `normalisePhone` / `isValidIndianMobile` / `maskPhone` that
 * historically lived in `src/lib/auth/phoneVerification.ts` now re-export
 * from HERE — every existing call site keeps working.
 *
 * Design constraints (from spec §3.7):
 *   - normalisePhone is PURE — never throws, never logs, no network.
 *   - The 10-digit national number must start with 6 / 7 / 8 / 9.
 *   - Country code is permanently 91 — there is NO `countryCode` argument.
 */

/** Canonical E.164 shape we store + emit everywhere downstream. */
export const E164_INDIA_RE = /^\+91[6-9]\d{9}$/;

/** Loose national-number predicate — 10 digits starting 6-9, no prefix. */
const NATIONAL_INDIA_RE = /^[6-9]\d{9}$/;

/**
 * Normalise any permissive Indian-phone format into the canonical
 * `+91XXXXXXXXXX` E.164 shape. Returns `null` for anything that can't
 * be coerced into a valid Indian mobile.
 *
 *   - `'9876543210'`         → `'+919876543210'`
 *   - `'09876543210'`        → `'+919876543210'`   (drop leading 0)
 *   - `'919876543210'`       → `'+919876543210'`   (prepend +)
 *   - `'+919876543210'`      → `'+919876543210'`   (pass through)
 *   - `'+91 98765 43210'`    → `'+919876543210'`   (strip whitespace)
 *   - `'+91-9876-543210'`    → `'+919876543210'`   (strip dashes)
 *   - `'91-9876543210'`      → `'+919876543210'`
 *   - `'(+91) 9876543210'`   → `'+919876543210'`   (strip parens)
 *
 *   - `'5876543210'`         → null  (5 is not a valid mobile prefix)
 *   - `'12345'`              → null  (too short)
 *   - `'98765432109'`        → null  (11 digits)
 *   - `''`, `'abcd'`         → null
 */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const leadingPlus = trimmed.startsWith('+');
  // Strip every non-digit character. Keeps the algorithm bullet-proof
  // against future weird inputs (NBSP, narrow-no-break space, etc.).
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length === 0) return null;

  // Resolve the 12-digit "country-code + national" form by trying each
  // legal prefix in turn — order matters (longest prefix wins).
  let s = digits;
  if (leadingPlus) {
    s = '+' + s;
  } else {
    // 091XXXXXXXXXX → strip leading 0 → 91XXXXXXXXXX
    if (s.length === 13 && s.startsWith('091')) s = s.slice(1);
    // 0XXXXXXXXXX  → strip leading 0 → XXXXXXXXXX
    if (s.length === 11 && s.startsWith('0'))   s = s.slice(1);
    // 91XXXXXXXXXX → prepend + → +91XXXXXXXXXX
    if (s.length === 12 && s.startsWith('91'))      s = '+' + s;
    // XXXXXXXXXX   → prepend +91
    else if (s.length === 10)                       s = '+91' + s;
  }

  return E164_INDIA_RE.test(s) ? s : null;
}

/** True when `raw` normalises to a valid Indian mobile E.164. */
export function isValidIndianMobile(raw: unknown): boolean {
  return normalisePhone(raw) !== null;
}

/**
 * Format an E.164 Indian mobile for display: `+91 98765 43210`.
 *
 * Defensive: invalid input (anything that isn't a clean E.164) is
 * returned unchanged. We DON'T re-normalise here — callers that have a
 * partial value should call `normalisePhone()` first if they want
 * normalisation.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (e164 === null || e164 === undefined || e164 === '') return '';
  if (!E164_INDIA_RE.test(e164)) return String(e164);
  // +91 98765 43210
  const ten = e164.slice(3);
  return `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`;
}

/**
 * Mask-for-display variant: `+91 ••••• ••1234`. Used by audit views and
 * the phone-verification confirmation screen where we want to show the
 * customer enough to recognise their number without re-printing it in
 * full.
 *
 * Same defensive rule as formatPhone — invalid input echoes through.
 */
export function maskPhoneForDisplay(e164: string | null | undefined): string {
  if (e164 === null || e164 === undefined || e164 === '') return '';
  if (!E164_INDIA_RE.test(e164)) return String(e164);
  const tail = e164.slice(-4);
  return `+91 ••••• ••${tail}`;
}

/**
 * Strip the `+91` prefix from an E.164 value for use in the `<PhoneField>`
 * digit input. Defensive — returns at most 10 digits, regardless of input.
 */
export function stripIndianPrefix(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  let s = String(value).trim();
  // Tolerate the formatted display variant too — strip whitespace.
  s = s.replace(/\s+/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  // Drop any non-digit that crept in (e.g. dashes from a paste before
  // the component's paste handler intercepts).
  s = s.replace(/\D+/g, '');
  return s.slice(0, 10);
}

// Re-export `NATIONAL_INDIA_RE` for the rare schema that needs it
// (e.g. a Zod refinement on a 10-digit input). The component itself
// uses character-count + digit-only stripping, not regex.
export { NATIONAL_INDIA_RE };
