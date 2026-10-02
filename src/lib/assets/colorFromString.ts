/**
 * Deterministic colour-from-string — Item 17.
 *
 *   Same input always returns the same `bg` / `text` pair. Used by the
 *   `<BrandLogo>` and `<CategoryImage>` fallbacks so the same brand
 *   always shows the same coloured tile — making the absence of a
 *   real logo feel intentional rather than random.
 *
 * Pure module — no React / Prisma / Next imports. Safe to import from
 * server and client code.
 */

/** FNV-1a 32-bit hash. Stable across machines and runtimes — no
 *  hidden hash randomisation (unlike Node's Map keys). */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Coerce to unsigned 32-bit for downstream modulo arithmetic.
  return h >>> 0;
}

export interface FallbackColour {
  /** CSS-ready `hsl(...)` background. */
  bg:    string;
  /** Either `#ffffff` (white) or `#111827` (slate-900) — chosen for
   *  WCAG-AA-ish contrast against the background. */
  text:  string;
  /** Raw HSL hue 0-359, useful for callers that want to mix shades. */
  hue:   number;
}

/** Map a non-empty string to a stable HSL pair. Empty / falsy input
 *  → neutral slate. */
export function colorFromString(input: string | null | undefined): FallbackColour {
  if (!input || input.trim() === '') {
    return { bg: 'hsl(220, 13%, 90%)', text: '#111827', hue: 220 };
  }
  const hue = fnv1a32(input.trim().toLowerCase()) % 360;
  // Fixed saturation / lightness keeps the palette readable. Lightness
  // 55% sits comfortably between "white text reads" and "dark text
  // reads" — we pick text colour by luminance below.
  const saturation = 65;
  const lightness  = 55;
  const bg = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  // Yellows / greens read better with dark text; blues / purples with
  // white. Crude but effective — convert to approximate luminance.
  const lumApprox = approxRelativeLuminance(hue, saturation, lightness);
  const text = lumApprox > 0.5 ? '#111827' : '#ffffff';
  return { bg, text, hue };
}

/** Crude HSL → luminance approximation. Good enough for choosing
 *  between two text colours — not for image processing. */
function approxRelativeLuminance(h: number, _s: number, l: number): number {
  // Lightness 0-100 maps roughly to luminance 0-1; warm hues (yellow ~60°
  // and green ~120°) read lighter than blues (~240°) at the same `l`.
  const warmth = 1 - Math.abs(((h + 90) % 360) - 180) / 180; // 0..1, peak at yellow/green
  return l / 100 + warmth * 0.12;
}

/** Initials helper — "Apple Computers" → "AC", "Apple" → "A", "" → "?". */
export function initialsFor(name: string | null | undefined, max = 2): string {
  if (!name || name.trim() === '') return '?';
  const parts = name.trim().split(/\s+/).slice(0, max);
  return parts.map((p) => p[0]!.toUpperCase()).join('');
}
