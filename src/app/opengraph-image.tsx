/**
 * Default Open Graph image — Item 17. 1200×630 (Twitter / Facebook
 * recommended). Used when a storefront URL is shared on chat /
 * social and no per-page override exists.
 *
 * Override order:
 *   1. `store.ogImageUrl` set        → 302-redirect to the uploaded
 *                                      asset (rendered upstream by
 *                                      the chat platform).
 *   2. Otherwise                     → generate a designed card with
 *                                      the store name + tagline on a
 *                                      brand-derived gradient.
 *
 * Per-page OG overrides (PDPs, etc.) live in those pages'
 * generateMetadata. This file is the SITE-WIDE default.
 */
import { ImageResponse } from 'next/og';
import { redirect } from 'next/navigation';
import { getStoreConfig } from '@/lib/storeConfig';
import { colorFromString } from '@/lib/assets/colorFromString';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt         = 'Open Graph image for ShopCore';

export default async function OpenGraphImage() {
  const cfg = await getStoreConfig();
  const store = cfg.store as { name?: string; tagline?: string; ogImageUrl?: string };
  const url = (store.ogImageUrl ?? '').trim();
  if (url !== '') redirect(url);

  const name    = store.name?.trim() || 'ShopCore';
  const tagline = store.tagline?.trim() || '';
  const palette = colorFromString(name);
  // @vercel/og's CSS subset is small — its parser doesn't accept
  // hsl() inside linear-gradient(), so we render the two stops as
  // hex and feed plain rgb() / hex values.
  const stop1 = hslToHex(palette.hue,                65, 50);
  const stop2 = hslToHex((palette.hue + 30) % 360,   65, 40);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column',
          justifyContent: 'center', padding: '0 80px',
          backgroundImage: `linear-gradient(135deg, ${stop1}, ${stop2})`,
          color: '#ffffff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ fontSize: 96, fontWeight: 800, lineHeight: 1.05 }}>{name}</div>
        {tagline && (
          <div style={{ marginTop: 24, fontSize: 36, fontWeight: 500, opacity: 0.92 }}>
            {tagline}
          </div>
        )}
      </div>
    ),
    { ...size },
  );
}

/** Convert HSL (s + l in 0-100) to a `#rrggbb` hex string. Inlined
 *  here so we don't need a runtime colour library inside the OG
 *  route (which would bloat the edge bundle). */
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
