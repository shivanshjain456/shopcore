import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import StorefrontHeader from '@/components/storefront/StorefrontHeader';

// Item 8 — the layout reads `headers()` + `getStoreConfig()` (Prisma)
// on every render. Both are dynamic-runtime concerns, so we explicitly
// opt out of static prerendering for the entire (storefront) segment.
// Previously this was implicit per-page; with the new layout it must
// be hoisted to the segment root.
export const dynamic = 'force-dynamic';
import StorefrontFooter from '@/components/storefront/StorefrontFooter';
import { CartProvider } from '@/components/storefront/CartProvider';
import { CompareProvider } from '@/components/storefront/CompareProvider';
import CompareTray from '@/components/storefront/CompareTray';
import BackButtonGuard from '@/components/auth/BackButtonGuard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import StorefrontErrorFallback from '@/components/storefront/StorefrontErrorFallback';
import { AnnouncementBanner } from '@/components/storefront/AnnouncementBanner';
import { FeatureFlagProvider } from '@/components/storefront/FeatureFlagProvider';
// `buildClientFlags` is in a separate non-`'use client'` module so that
// the server layout can call it directly. Named exports of plain
// functions from `'use client'` modules get wrapped as client-component
// references and crash with `TypeError: b is not a function` when
// invoked from server code.
import { buildClientFlags } from '@/lib/storeConfig/clientFlags';
import { getStoreConfig } from '@/lib/storeConfig';
import { isIpAllowedDuringMaintenance } from '@/lib/storeConfig/maintenance';

export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  // ── Item 8 — Maintenance mode gate ─────────────────────────────────
  // We CANNOT do this in middleware (Edge runtime + no Prisma). The
  // storefront layout runs on every public-facing page render and
  // getStoreConfig() is cached, so the overhead is one cache hit per
  // render (~µs). Admin routes live under a DIFFERENT layout
  // (src/app/admin/(app)/layout.tsx) so they're naturally unaffected;
  // auth endpoints are API routes outside this layout's tree.
  const config = await getStoreConfig();
  if (config.maintenance.maintenanceMode) {
    const h = headers();
    const clientIp =
      (h.get('x-forwarded-for') ?? '').split(',')[0].trim()
      || h.get('x-real-ip')
      || null;
    if (!isIpAllowedDuringMaintenance(config, clientIp)) {
      redirect('/maintenance');
    }
  }

  // ── Item 8 Phase 2 — Feature flags for client components ──────────
  const clientFlags = buildClientFlags(config as unknown as {
    features: Record<string, unknown>; maintenance: Record<string, unknown>;
  });

  return (
    <FeatureFlagProvider flags={clientFlags}>
      <CompareProvider>
      <CartProvider>
        <BackButtonGuard />
        {/* Item 8 — admin-toggled sitewide announcement. Server component,
            renders nothing when disabled / expired / empty. */}
        <AnnouncementBanner />
        <StorefrontHeader
          storeName={(config.store as { name?: string }).name ?? ''}
          logoUrl={(config.store as { logoUrl?: string }).logoUrl ?? ''}
          logoAlt={(config.store as { logoAlt?: string }).logoAlt ?? ''}
        />
        <div className="min-h-[60vh]">
          {/*
            Per-segment error boundary — catches CLIENT-component render
            errors below the header without taking down the chrome.
            Server-component errors bubble to `error.tsx` instead.

            We pass the fallback as a ReactNode (NOT a function) because
            this layout is a SERVER component — Next.js forbids passing
            functions as props into a client boundary across the
            server/client divide. The render-prop API of <ErrorBoundary>
            still exists for callers that ARE client components.
          */}
          <ErrorBoundary fallback={<StorefrontErrorFallback />}>
            {children}
          </ErrorBoundary>
        </div>
        <StorefrontFooter />
      </CartProvider>
      <CompareTray />
      </CompareProvider>
    </FeatureFlagProvider>
  );
}
