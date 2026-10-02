/**
 * GET /api/hero-banners — Feature #15.
 *
 *   Public, anonymous, cacheable list of active+in-window hero banners
 *   for the storefront carousel.
 *
 *   Returns:
 *     {
 *       banners: HeroBannerView[],
 *       config:  { autoplayMs, resumeAfterMs, hideWhenEmpty, showDots, showArrows },
 *     }
 *
 *   The carousel reads BOTH so it never needs a second round-trip for the
 *   admin-controlled autoplay knobs.
 *
 *   Cache: 60 s public + 5 min SWR. Banners change at human-edit cadence,
 *   so a minute of staleness in exchange for zero cold-load on the home
 *   page is the right trade.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { listVisibleBanners } from '@/lib/cms/heroBanners';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { DEFAULT_STORE_CONFIG } from '@/lib/config';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const [banners, cfg] = await Promise.all([
    listVisibleBanners(),
    getStoreConfig(),
  ]);
  // Fall back to the in-code defaults if the stored config predates
  // Feature #15 and doesn't carry a `hero` block.
  const hero = (cfg as unknown as { hero?: typeof DEFAULT_STORE_CONFIG.hero }).hero
    ?? DEFAULT_STORE_CONFIG.hero;
  return jsonOk({ banners, config: hero }, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
});
