/**
 * Bulk-upload filename → slug matching — Item 17 Phase 2.
 *
 *   Pure, sync, no I/O. The admin selects multiple files; the dashboard
 *   client component calls `matchFilenamesToBrands` (or
 *   `matchFilenamesToCategories`) to propose an assignment per file
 *   BEFORE any upload happens. Unmatched files surface in a separate
 *   list so the admin can manually pick a brand from a dropdown.
 *
 * Algorithm:
 *   1. Strip the extension + sanitise the base name to slug form
 *      (lowercase, non-alphanumeric → '-', collapse repeats).
 *   2. Exact match against each candidate slug.
 *   3. If no exact hit, try Levenshtein distance ≤ 2 against every
 *      candidate. If exactly one candidate is within the distance,
 *      propose it. Multiple ties → unmatched (don't guess).
 */

export interface MatchCandidate {
  id:   string;
  slug: string;
  name: string;
}

export interface FilenameMatchResult {
  filename:  string;
  /** Slug-form of the filename (extension stripped, sanitised). */
  normalised:string;
  /** Matched candidate (exact or unique fuzzy). `null` = unmatched. */
  match:     MatchCandidate | null;
  /** Tells the UI whether to label the match as confident or fuzzy. */
  matchType: 'exact' | 'fuzzy' | 'none';
}

/** Strip extension + lowercase + non-alphanumeric → '-' + collapse. */
export function normaliseFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Standard Levenshtein edit distance. Capped at `max + 1` for early
 *  exit on long strings — we only care about distances 0/1/2. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Two-row DP — minimal memory.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // delete
        curr[j - 1] + 1,    // insert
        prev[j - 1] + cost, // substitute
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // Early exit: if every cell in this row exceeds max, we can't
    // recover. Pure perf — correctness unaffected.
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function matchFilenameToCandidate(
  filename: string,
  candidates: readonly MatchCandidate[],
  fuzzyMax = 2,
): FilenameMatchResult {
  const normalised = normaliseFilename(filename);
  // Empty normalised → can't match anything.
  if (normalised === '') {
    return { filename, normalised, match: null, matchType: 'none' };
  }
  // Pass 1: exact match.
  const exact = candidates.find((c) => c.slug === normalised);
  if (exact) {
    return { filename, normalised, match: exact, matchType: 'exact' };
  }
  // Pass 2: unique fuzzy match.
  const within: MatchCandidate[] = [];
  for (const c of candidates) {
    if (editDistance(normalised, c.slug, fuzzyMax) <= fuzzyMax) {
      within.push(c);
    }
  }
  if (within.length === 1) {
    return { filename, normalised, match: within[0]!, matchType: 'fuzzy' };
  }
  // Zero matches OR ambiguous — don't guess.
  return { filename, normalised, match: null, matchType: 'none' };
}

export function matchFilenamesToCandidates(
  filenames: readonly string[],
  candidates: readonly MatchCandidate[],
): FilenameMatchResult[] {
  return filenames.map((f) => matchFilenameToCandidate(f, candidates));
}
