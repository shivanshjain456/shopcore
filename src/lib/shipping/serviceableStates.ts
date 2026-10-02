/**
 * Serviceable-states allowlist — Feature #13.
 *
 * Single source of truth for "does ShopCore deliver to this region?". This is
 * intentionally in a constants module (not in any component) so adding /
 * removing a state is a one-line PR with no UI churn.
 *
 * Default: every Indian state + every UT is serviceable. Edit this set to
 * temporarily disable a region (e.g. weather closures, courier outages).
 *
 * Used by:
 *   - `lib/pincode/indiaPost.ts` → annotates each lookup result with
 *      `isServiceable` so the UI can show a soft warning.
 *   - `/api/pincode/[pincode]/route.ts` → echoes the flag in the proxy
 *      response so the client never needs to ship the list.
 *
 * NOTE: serviceability is INFORMATIONAL only. Per the spec we MUST allow
 * the user to fill the form manually and proceed even when a pincode is
 * declared unserviceable. The flag exists so we can show a friendly heads-up
 * ("we may not deliver here yet — please double-check") not as a hard block.
 */
import { INDIAN_STATES } from '@/lib/enums';

/** All 36 Indian states + UTs from the project's canonical list. */
export const SERVICEABLE_STATES: ReadonlyArray<string> = INDIAN_STATES;

/**
 * Case-insensitive match against the serviceable list. Many India Post
 * payloads return "TAMIL NADU" or "tamil nadu" — normalise both sides.
 */
export function isStateServiceable(state: string | null | undefined): boolean {
  if (!state) return false;
  const norm = state.trim().toLowerCase();
  return SERVICEABLE_STATES.some((s) => s.toLowerCase() === norm);
}

/**
 * Find the canonical (title-cased) name for a state name returned by
 * the India Post API, if any. Returns null when the name is unrecognised
 * (so the caller can fall back to the raw value).
 *
 * The India Post payload sometimes returns abbreviations or different
 * casing (e.g. "DELHI" vs "Delhi"); this resolver shields the UI from
 * having to know about it.
 */
export function canonicaliseState(state: string | null | undefined): string | null {
  if (!state) return null;
  const norm = state.trim().toLowerCase();
  const exact = SERVICEABLE_STATES.find((s) => s.toLowerCase() === norm);
  if (exact) return exact;
  // Common India Post aliases.
  const alias: Record<string, string> = {
    'pondicherry':              'Puducherry',
    'pondichery':               'Puducherry',
    'orissa':                   'Odisha',
    'jammu and kashmir state':  'Jammu and Kashmir',
    'daman and diu':            'Dadra and Nagar Haveli and Daman and Diu',
    'dadra and nagar haveli':   'Dadra and Nagar Haveli and Daman and Diu',
    'andaman & nicobar islands':'Andaman and Nicobar Islands',
  };
  return alias[norm] ?? null;
}
