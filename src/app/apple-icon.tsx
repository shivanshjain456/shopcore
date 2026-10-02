/**
 * Apple touch icon — Item 17. Same pattern as /icon but at 180×180
 * (Apple's recommended size). Reuses store.appIconUrl when set so
 * admins who care about the PWA home-screen experience can override.
 */
import { ImageResponse } from 'next/og';
import { redirect } from 'next/navigation';
import { getStoreConfig } from '@/lib/storeConfig';
import { colorFromString, initialsFor } from '@/lib/assets/colorFromString';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const size        = { width: 180, height: 180 };
export const contentType = 'image/png';

export default async function AppleIcon() {
  const cfg = await getStoreConfig();
  const store = cfg.store as { name?: string; appIconUrl?: string; faviconUrl?: string };
  // Prefer the dedicated PWA icon; fall back to the favicon URL.
  const url = (store.appIconUrl ?? store.faviconUrl ?? '').trim();
  if (url !== '') redirect(url);

  const name     = store.name?.trim() || 'ShopCore';
  const initial  = initialsFor(name, 1);
  const palette  = colorFromString(name);
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: hslToHex(palette.hue, 65, 55), color: palette.text,
          fontSize: 120, fontWeight: 800,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {initial}
      </div>
    ),
    { ...size },
  );
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100, lN = l / 100;
  const c  = (1 - Math.abs(2 * lN - 1)) * sN;
  const x  = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m  = lN - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if      (h <  60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else              { r1 = c; g1 = 0; b1 = x; }
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
