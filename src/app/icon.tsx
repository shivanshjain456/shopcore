/**
 * Dynamic favicon — Item 17. Served at /icon (Next.js App Router
 * picks this up as the document `<link rel="icon">` automatically).
 *
 * Strategy:
 *   1. `store.faviconUrl` set       → 302-redirect to that URL. The
 *                                      admin's uploaded PNG is served
 *                                      by /api/uploads/public-images/...
 *                                      with year-long immutable cache,
 *                                      so the redirect is cheap.
 *   2. `store.name` available       → generate a 64×64 PNG via
 *                                      next/og's ImageResponse: the
 *                                      store's first letter in the
 *                                      brand-derived colour.
 *   3. Nothing                      → 404 (lets the browser fall back
 *                                      to /favicon.ico if any).
 *
 * Pure server — no client JS. Re-rendered per request; the in-process
 * store-config cache (30s) keeps this fast.
 */
import { ImageResponse } from 'next/og';
import { redirect } from 'next/navigation';
import { getStoreConfig } from '@/lib/storeConfig';
import { colorFromString, initialsFor } from '@/lib/assets/colorFromString';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const size        = { width: 64, height: 64 };
export const contentType = 'image/png';

export default async function Icon() {
  const cfg = await getStoreConfig();
  const store = cfg.store as { name?: string; faviconUrl?: string };
  const url = (store.faviconUrl ?? '').trim();
  if (url !== '') {
    // Admin uploaded a real favicon — hand the browser straight to it.
    redirect(url);
  }
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
          fontSize: 44, fontWeight: 800,
          fontFamily: 'system-ui, sans-serif',
          borderRadius: 12,
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
