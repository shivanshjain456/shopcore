/**
 * <StoreLogo> — Item 17.
 *
 * Three-state rendering:
 *   1. `logoUrl` provided  → real <img> (with onError fallback).
 *   2. No logo, storeName  → inline SVG word-mark generated from the
 *                            store name. Looks designed, not "missing".
 *   3. Neither              → static "ShopCore" text — last resort.
 *
 * The fallback is generated SERVER-SIDE as inline SVG so the header
 * never flashes anything broken between first paint and hydration.
 *
 * The component is a server component by default — pass it the data
 * directly. The image fallback-on-error is provided by a tiny client
 * sub-component for the `<img>` case only.
 */
import Link from 'next/link';
import { colorFromString } from '@/lib/assets/colorFromString';
import StoreLogoImage from './StoreLogoImage';

interface Props {
  logoUrl:    string | null | undefined;
  storeName:  string;
  logoAlt?:   string;
  /** Pixel height. Mobile callers should pass 32; desktop 40. */
  height?:    number;
  /** Wrapper className for layout customisation. */
  className?: string;
  /** When false, the logo is not wrapped in a <Link href="/">. */
  asLink?:    boolean;
}

export default function StoreLogo({
  logoUrl, storeName, logoAlt, height = 40, className, asLink = true,
}: Props) {
  const safeName = storeName && storeName.trim() !== '' ? storeName.trim() : 'ShopCore';
  const alt = logoAlt && logoAlt.trim() !== '' ? logoAlt.trim() : safeName;
  const palette = colorFromString(safeName);

  const inner = logoUrl && logoUrl.trim() !== ''
    ? <StoreLogoImage logoUrl={logoUrl} alt={alt} height={height} fallbackName={safeName} fallbackPalette={palette} />
    : <SvgWordmark name={safeName} height={height} palette={palette} />;

  if (!asLink) return <span className={className}>{inner}</span>;
  return (
    <Link href="/" aria-label={`${safeName} home`} className={`inline-flex items-center ${className ?? ''}`}>
      {inner}
    </Link>
  );
}

/** Inline SVG word-mark — sized to the requested height, width
 *  auto-derived from a per-character estimate so it never overflows
 *  the header. */
function SvgWordmark({
  name, height, palette,
}: {
  name: string; height: number; palette: ReturnType<typeof colorFromString>;
}) {
  const fontSize  = Math.round(height * 0.55);
  const padding   = Math.round(height * 0.25);
  // Approximate text width — 0.6 × fontSize per char + padding.
  const textWidth = Math.ceil(name.length * fontSize * 0.6);
  const width     = textWidth + padding * 2;
  return (
    <svg
      role="img"
      aria-label={`${name} logo`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{name}</title>
      {/* Subtle pill background using the brand-derived palette so the
          mark feels designed rather than typeset. */}
      <rect width={width} height={height} rx={Math.round(height / 4)} fill={palette.bg} />
      <text
        x={width / 2}
        y={height / 2 + fontSize * 0.35}
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        fontSize={fontSize}
        fontWeight={800}
        fill={palette.text}
      >
        {name}
      </text>
    </svg>
  );
}
