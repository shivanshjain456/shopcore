/**
 * Union-of-keys algorithm — Item 14.
 *
 * Given N products' attribute maps, return:
 *   - The union of every key that appears in any product
 *   - Stable ordering: first by the order in which the key was first
 *     encountered (so the on-screen order matches the leftmost product's
 *     key order — a reasonable default with no good alternative)
 *
 * Pure module — no Prisma / Next imports.
 */

/**
 * Parse a single product's `attributes` JSON column safely. Returns an
 * empty object on null, undefined, malformed JSON, or non-object values.
 * Never throws — the compare view must keep rendering even for one
 * malformed product.
 */
export function parseAttributes(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Return the ordered union of every attribute key across the supplied
 * products. Insertion order = first-seen order.
 */
export function unionAttributeKeys(productAttrs: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const attrs of productAttrs) {
    for (const k of Object.keys(attrs)) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Subtract the keys already covered by a list of declared attribute
 * groups from the unioned set. The remainder is what goes into the
 * synthetic "Other specifications" group at render time.
 */
export function leftoverAttributeKeys(allKeys: string[], coveredKeys: string[]): string[] {
  const covered = new Set(coveredKeys);
  return allKeys.filter((k) => !covered.has(k));
}
