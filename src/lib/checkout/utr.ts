/**
 * UTR (Unique Transaction Reference) validation & anti-fraud helpers.
 *
 * Indian retail payment systems and their reference-number formats
 * (sourced from NPCI / RBI public specifications — NOT invented):
 *
 *   UPI  — 12 digits, the RBI/NPCI RRN. e.g. "425912345678".
 *          UPI apps display this as "UPI Reference No" / "UTR".
 *   IMPS — 12 digits, RRN, same shape as UPI for retail rails.
 *   NEFT — 16-char alphanumeric: <IFSC-4-letters>N<11-digits>
 *          e.g. "SBIN0123456789012". "N" marks NEFT.
 *   RTGS — 16-22 alphanumeric: <IFSC-4-letters>R<11+ digits>
 *          e.g. "SBINR52022060812345" or longer (UTRs from corporate
 *          batches may run 18-22 chars).
 *
 * We deliberately do NOT enforce IFSC dictionary lookups — that would
 * require shipping a 100k-row table that ages out of date. The 4-letter
 * prefix shape is enough to reject random gibberish while accepting any
 * legitimate bank.
 *
 * The pipeline:
 *   sanitize()        — trim, strip non-alphanumerics, uppercase
 *   validateFormat()  — method-specific regex
 *   detectFraud()     — repeated digits, "TEST", obvious sequentials
 *   assertAcceptable()— composes the three above + returns a structured
 *                       result for the route handler
 *   maskUtr()         — for any value that leaves the server
 *
 * Anti-replay protection lives in the DB (`UtrSubmission.utrNormalized`
 * UNIQUE constraint). This file only governs SHAPE and PATTERN.
 */

export type PaymentMethod = 'UPI' | 'IMPS' | 'NEFT' | 'RTGS';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['UPI', 'IMPS', 'NEFT', 'RTGS'] as const;
export function isPaymentMethod(s: unknown): s is PaymentMethod {
  return typeof s === 'string' && (PAYMENT_METHODS as readonly string[]).includes(s);
}

/**
 * Sanitise raw user input:
 *   - trim leading/trailing whitespace
 *   - strip any character that is not [A-Za-z0-9]
 *   - uppercase (all valid UTR alphabets are upper)
 * Returns '' for unusable input. NEVER returns null/undefined.
 */
export function sanitizeUtr(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s;
}

/** Per-method exact-shape regex (anchored, no partial matches). */
const FORMAT: Record<PaymentMethod, RegExp> = {
  UPI:  /^\d{12}$/,
  IMPS: /^\d{12}$/,
  NEFT: /^[A-Z]{4}N\d{11}$/,
  RTGS: /^[A-Z]{4}R\d{11,17}$/,
};

export interface FormatResult {
  ok: boolean;
  reason?: string;
}
export function validateUtrFormat(sanitized: string, method: PaymentMethod): FormatResult {
  if (!sanitized) return { ok: false, reason: 'Transaction ID is required.' };
  const re = FORMAT[method];
  if (!re) return { ok: false, reason: `Unknown payment method: ${String(method)}.` };
  if (!re.test(sanitized)) {
    switch (method) {
      case 'UPI':  return { ok: false, reason: 'UPI Transaction ID (UTR) must be exactly 12 digits — check your UPI app under "UPI Ref No".' };
      case 'IMPS': return { ok: false, reason: 'IMPS Reference Number must be exactly 12 digits.' };
      case 'NEFT': return { ok: false, reason: 'NEFT UTR must be 16 characters: 4-letter IFSC + "N" + 11 digits (e.g. SBIN0123456789012).' };
      case 'RTGS': return { ok: false, reason: 'RTGS UTR must be 16–22 characters: 4-letter IFSC + "R" + 11+ digits.' };
    }
  }
  return { ok: true };
}

/** Patterns we treat as obvious fakes / test values. */
const FRAUD_PATTERNS: Array<{ test: (s: string) => boolean; reason: string }> = [
  { test: (s) => /^(\d)\1+$/.test(s),          reason: 'Transaction ID consists of a single repeated digit — please enter the actual reference.' },
  { test: (s) => /^0+$/.test(s),               reason: 'Transaction ID cannot be all zeros.' },
  { test: (s) => /TEST|DEMO|FAKE|SAMPLE|XXXX|NULL/.test(s),
                                                reason: 'Transaction ID contains placeholder text.' },
  { test: (s) => /^012345678901$|^123456789012$|^987654321098$|^098765432109$/.test(s),
                                                reason: 'Transaction ID looks like a sequence; please re-check your bank/UPI app.' },
  // Repeating short groups: 1212121212... or ABCDABCDABCD across full length
  { test: (s) => s.length >= 8 && /^(.{1,4})\1{2,}$/.test(s),
                                                reason: 'Transaction ID looks repetitive; please re-check.' },
];

export interface FraudResult { ok: boolean; reason?: string; }
export function detectFraudPattern(sanitized: string): FraudResult {
  for (const p of FRAUD_PATTERNS) {
    if (p.test(sanitized)) return { ok: false, reason: p.reason };
  }
  return { ok: true };
}

export type UtrRejectCode =
  | 'EMPTY' | 'BAD_METHOD' | 'BAD_FORMAT' | 'FRAUD_PATTERN' | 'DUPLICATE';

export type AssertResult =
  | { ok: true; sanitized: string; method: PaymentMethod }
  | { ok: false; code: UtrRejectCode; reason: string };

/** One call covers sanitise + method + format + fraud-pattern. Uniqueness is
 *  enforced separately by the DB unique constraint on UtrSubmission. */
export function assertUtrAcceptable(rawUtr: unknown, methodIn: unknown): AssertResult {
  if (!isPaymentMethod(methodIn)) {
    return { ok: false, code: 'BAD_METHOD', reason: `Payment method must be one of ${PAYMENT_METHODS.join(', ')}.` };
  }
  const sanitized = sanitizeUtr(rawUtr);
  if (!sanitized) {
    return { ok: false, code: 'EMPTY', reason: 'Transaction ID is required.' };
  }
  const fmt = validateUtrFormat(sanitized, methodIn);
  if (!fmt.ok) {
    return { ok: false, code: 'BAD_FORMAT', reason: fmt.reason ?? 'Invalid Transaction ID format.' };
  }
  const fraud = detectFraudPattern(sanitized);
  if (!fraud.ok) {
    return { ok: false, code: 'FRAUD_PATTERN', reason: fraud.reason ?? 'Transaction ID rejected by fraud filter.' };
  }
  return { ok: true, sanitized, method: methodIn };
}

/**
 * Mask a UTR for client-facing responses.
 *   "425912345678" → "********5678"
 *   "SBINN12345678901" → "************8901"
 * Always reveals the LAST 4 characters; preserves length so the receiver
 * can still tell at a glance which method (UPI 12 / NEFT 16 / etc.).
 */
export function maskUtr(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}
