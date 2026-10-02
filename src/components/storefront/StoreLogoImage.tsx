'use client';
/**
 * <StoreLogoImage> — Item 17 (client helper for <StoreLogo>).
 *
 * Renders the admin-uploaded store logo. On image load failure, swaps
 * to the same SVG word-mark fallback the server-rendered code path
 * uses — guarantees the header never shows a broken image icon.
 */
import { useState } from 'react';
import { colorFromString } from '@/lib/assets/colorFromString';

interface Props {
  logoUrl:         string;
  alt:             string;
  height:          number;
  fallbackName:    string;
  fallbackPalette: ReturnType<typeof colorFromString>;
}

export default function StoreLogoImage({ logoUrl, alt, height, fallbackName, fallbackPalette }: Props) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    const fontSize  = Math.round(height * 0.55);
    const padding   = Math.round(height * 0.25);
    const textWidth = Math.ceil(fallbackName.length * fontSize * 0.6);
    const width     = textWidth + padding * 2;
    return (
      <svg
        role="img" aria-label={alt}
        width={width} height={height}
        viewBox={`0 0 ${width} ${height}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>{fallbackName}</title>
        <rect width={width} height={height} rx={Math.round(height / 4)} fill={fallbackPalette.bg} />
        <text
          x={width / 2}
          y={height / 2 + fontSize * 0.35}
          textAnchor="middle"
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          fontSize={fontSize}
          fontWeight={800}
          fill={fallbackPalette.text}
        >
          {fallbackName}
        </text>
      </svg>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={alt}
      height={height}
      style={{ height, width: 'auto' }}
      onError={() => setBroken(true)}
      className="object-contain"
    />
  );
}
