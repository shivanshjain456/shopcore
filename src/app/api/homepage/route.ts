/**
 * GET /api/homepage — Item 18 Phase 1.
 *
 *   Public read of the composed homepage: ordered sections with all
 *   per-section data resolved. The storefront page calls
 *   getHomepageComposition() directly (server component → no HTTP
 *   round-trip needed), but this endpoint exists for:
 *     - mobile / native shells that want the same data,
 *     - integration tests asserting end-to-end resolution,
 *     - and admin "preview" calls.
 *
 *   Gated by features.homepageRevampEnabled. Cached at
 *   Cache-Control: public, max-age=30 to absorb traffic bursts
 *   without delaying admin edits significantly.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { NextResponse } from 'next/server';
import { isHomepageRevampEnabled } from '@/lib/storeConfig/featureGate';
import { getHomepageComposition } from '@/lib/cms/homepage';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const enabled = await isHomepageRevampEnabled();
  if (!enabled) return jsonOk({ enabled: false, sections: [] });
  const comp = await getHomepageComposition();
  const res = jsonOk({ enabled: true, sections: comp.sections });
  // 30-second cache: edits show up within half a minute. Use the
  // admin "Refresh storefront" button (Phase 2) for instant.
  (res as NextResponse).headers.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return res;
});
