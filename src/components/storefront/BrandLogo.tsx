'use client';
/**
 * <BrandLogo> — Item 17.
 *
 * Renders a brand logo with a designed fallback so customers NEVER
 * see a broken `<img>` icon.
 *
 *   - `logoUrl` provided + image loads → show the real logo.
 *   - `logoUrl` empty OR image errors  → coloured tile with the
 *     brand's initials, background deterministically derived from
 *     the brand name (same brand always gets the same colour).
 *
 * The component is intentionally NOT a Next.js `<Image>` — the
 * upload-served `/api/uploads/public-images/brand/<file>` URLs are
 * same-origin and cache-friendly already, and using `<img>` keeps
 * the in-iframe preview working without `next.config.mjs` patches.
 */
import { useState } from 'react';
import { colorFromString, initialsFor } from '@/lib/assets/colorFromString';

interface Props {
  logoUrl: string | null | undefined;
  name:    string;
  /** Pixel size (square). Default 64. */
  size?:   number;
  /** Tailwind classes to merge into the outer wrapper. */
  className?: string;
}

export default function BrandLogo({ logoUrl, name, size = 64, className }: Props) {
  const [broken, setBroken] = useState(false);
  const showFallback = !logoUrl || logoUrl.trim() === '' || broken;
  const palette = colorFromString(name);
  const initials = initialsFor(name);
  const dim = { width: size, height: size };

  if (showFallback) {
    return (
      <div
        role="img"
        aria-label={`${name} logo`}
        style={{ ...dim, background: palette.bg, color: palette.text }}
        className={`grid select-none place-items-center rounded-md font-bold ${className ?? ''}`}
      >
        <span style={{ fontSize: Math.round(size * 0.4) }}>{initials}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={`${name} logo`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className={`rounded-md object-contain ${className ?? ''}`}
      style={dim}
    />
  );
}
