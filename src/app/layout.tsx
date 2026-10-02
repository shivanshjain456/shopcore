import type { Metadata, Viewport } from 'next';
import './globals.css';
import { DialogProvider } from '@/components/dialog/DialogProvider';
import { getStoreConfig } from '@/lib/storeConfig';

/**
 * Item 17 — every storefront page inherits this metadata. Title and
 * description come from admin store config (zero hardcoded copy);
 * the OG image points at /opengraph-image which itself reads config.
 *
 * Per-page generateMetadata (PDP, etc.) further specialises this base
 * — Next.js shallow-merges the two.
 */
export async function generateMetadata(): Promise<Metadata> {
  const cfg = await getStoreConfig();
  const store = cfg.store as { name?: string; tagline?: string };
  const name    = store.name?.trim()    || 'ShopCore';
  const tagline = store.tagline?.trim() || 'India-only e-commerce for laptops, desktops and electronics.';
  return {
    title:       { default: name, template: `%s — ${name}` },
    description: tagline,
    robots:      { index: true, follow: true },
    openGraph: {
      type:        'website',
      siteName:    name,
      title:       name,
      description: tagline,
      // /opengraph-image is the dynamic OG image we generate from
      // store.ogImageUrl OR a designed fallback. Next.js automatically
      // wires the absolute URL.
      images:      ['/opengraph-image'],
    },
    twitter: {
      card:        'summary_large_image',
      title:       name,
      description: tagline,
      images:      ['/opengraph-image'],
    },
  };
}

/**
 * Feature #14 — global responsive viewport contract.
 *
 *  - `width=device-width` + `initialScale=1`         → real CSS pixels on mobile
 *  - `maximumScale=5`                                → DOES allow user-zoom (a11y;
 *                                                     never lock zoom for accessibility)
 *  - `viewportFit='cover'`                           → safe-area-inset support
 *                                                     (notched iPhones)
 *  - `themeColor` pair                               → matches the storefront chrome
 *                                                     in both light + dark UAs
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)',  color: '#0f172a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900 antialiased">
        <DialogProvider>
          {children}
        </DialogProvider>
      </body>
    </html>
  );
}
