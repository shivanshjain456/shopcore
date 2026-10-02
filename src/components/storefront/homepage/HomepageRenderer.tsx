/**
 * <HomepageRenderer> — Item 18 Phase 1.
 *
 *   Server component. Receives a `ResolvedSection[]` (already filtered
 *   by the service for active + scheduled + feature-flag-allowed
 *   sections) and dispatches each to the matching block component.
 *
 *   Feature-flag filtering happens HERE (rather than in the service)
 *   so admins can disable an entire category of sections without
 *   touching every row. The service returns everything that's active +
 *   in-window; this component drops sections whose flag is off.
 */
import {
  HeroBlock,
  FeaturedBrandsBlock, TopCategoriesBlock,
  ProductCollectionBlock, WidePromoBannerBlock,
  DualPromoCardsBlock, BrandShowcaseBlock,
  StoreMetricsBlock, WhyShopWithUsBlock,
  BranchesBlock, NewsletterBlock,
} from './blocks';
import type { ResolvedSection } from '@/lib/cms/homepage';
import type { ClientFeatureFlags } from '@/lib/storeConfig/clientFlags';

interface Props {
  sections: ResolvedSection[];
  /** Subset of the homepage-related client flags. We accept them as a
   *  prop so the page server-component can compute them once (it
   *  already calls getStoreConfig). */
  flags: {
    homepageBrandsEnabled:   boolean;
    homepageMetricsEnabled:  boolean;
    homepageBranchesEnabled: boolean;
  };
}

const BRAND_KINDS    = new Set(['FEATURED_BRANDS', 'BRAND_SHOWCASE']);
const METRIC_KINDS   = new Set(['STORE_METRICS']);
const BRANCH_KINDS   = new Set(['BRANCHES']);

export default function HomepageRenderer({ sections, flags }: Props) {
  return (
    <>
      {sections.map((s) => {
        // Feature-flag gating per category.
        if (BRAND_KINDS.has(s.kind)  && !flags.homepageBrandsEnabled)   return null;
        if (METRIC_KINDS.has(s.kind) && !flags.homepageMetricsEnabled)  return null;
        if (BRANCH_KINDS.has(s.kind) && !flags.homepageBranchesEnabled) return null;
        return <RenderOne key={s.id} section={s} />;
      })}
    </>
  );
}

function RenderOne({ section }: { section: ResolvedSection }) {
  switch (section.kind) {
    case 'HERO':
      return <HeroBlock />;
    case 'FEATURED_BRANDS': {
      const c = section.config as { heading?: string; subheading?: string };
      return <FeaturedBrandsBlock heading={c.heading} subheading={c.subheading} brands={section.brands} />;
    }
    case 'TOP_CATEGORIES': {
      const c = section.config as { heading?: string; subheading?: string; layout?: 'tiles' | 'compact' };
      return <TopCategoriesBlock heading={c.heading} subheading={c.subheading} layout={c.layout} categories={section.categories} />;
    }
    case 'PRODUCT_COLLECTION':
    case 'MOST_RATED_PRODUCTS':
    case 'TRENDING_PRODUCTS': {
      const c = section.config as { heading?: string; subheading?: string; theme?: string; cta?: { label?: string; href?: string } };
      return <ProductCollectionBlock heading={c.heading} subheading={c.subheading} theme={c.theme} cta={c.cta} products={section.products} />;
    }
    case 'WIDE_PROMO_BANNER': {
      const c = section.config as { imageDesktopUrl?: string; imageMobileUrl?: string; imageAlt?: string; headline?: string; subheadline?: string; cta?: { label?: string; href?: string } };
      return <WidePromoBannerBlock {...c} />;
    }
    case 'DUAL_PROMO_CARDS': {
      const c = section.config as { heading?: string; left: never; right: never };
      return <DualPromoCardsBlock heading={c.heading} left={c.left} right={c.right} />;
    }
    case 'BRAND_SHOWCASE': {
      const c = section.config as { heading?: string; subheading?: string; scrollMode?: 'scroll' | 'static' };
      return <BrandShowcaseBlock heading={c.heading} subheading={c.subheading} scrollMode={c.scrollMode} brands={section.brands} />;
    }
    case 'STORE_METRICS': {
      const c = section.config as { heading?: string; subheading?: string; theme?: string };
      return <StoreMetricsBlock heading={c.heading} subheading={c.subheading} theme={c.theme} metrics={section.metrics} />;
    }
    case 'WHY_SHOP_WITH_US': {
      const c = section.config as { heading?: string; subheading?: string; cards?: Array<{ title: string; description?: string; iconUrl?: string }> };
      return <WhyShopWithUsBlock heading={c.heading} subheading={c.subheading} cards={c.cards ?? []} />;
    }
    case 'BRANCHES': {
      const c = section.config as { heading?: string; subheading?: string };
      return <BranchesBlock heading={c.heading} subheading={c.subheading} branches={section.branches} />;
    }
    case 'NEWSLETTER': {
      const c = section.config as { heading?: string; description?: string; ctaLabel?: string; backgroundUrl?: string };
      return <NewsletterBlock {...c} />;
    }
  }
}
