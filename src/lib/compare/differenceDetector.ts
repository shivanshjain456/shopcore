/**
 * Difference detector — Item 14.
 *
 * Pure functions that drive the "highlight differences" UX and the
 * "Show only differences" toggle. Case-insensitive string comparison
 * handles "AMD" vs "amd" without flagging a difference; numeric vs
 * stringified-numeric values (`1.5` vs `"1.5"`) compare equal.
 */

/** Canonical compare key for one value. Trims, lowercases strings;
 *  coerces numbers/booleans to strings; treats null/undefined as a
 *  sentinel `""`. */
export function normaliseForCompare(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((v) => normaliseForCompare(v)).join('|');
  }
  if (typeof value === 'object') {
    // For structured cells (e.g. `{ value: 1500, unit: 'g' }`) compare
    // the JSON form so identical objects don't trip a false diff.
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value).trim().toLowerCase();
}

/** True iff both values normalise to the same canonical form. */
export function isEqualValue(a: unknown, b: unknown): boolean {
  return normaliseForCompare(a) === normaliseForCompare(b);
}

/**
 * Given an array of values (one per compared product), report whether
 * any pair differs. Two-product case is the common shortcut: just
 * compare the two. For three or four, compare each against the first
 * — if any disagrees, the row has a diff.
 *
 * A row of all-empties (every product missing the attribute) is NOT
 * a difference — there's nothing to compare.
 */
export function detectDifference(values: unknown[]): boolean {
  if (values.length < 2) return false;
  const normalised = values.map(normaliseForCompare);
  // All empty → not a difference (nothing to highlight).
  if (normalised.every((v) => v === '')) return false;
  const first = normalised[0];
  return normalised.some((v) => v !== first);
}
