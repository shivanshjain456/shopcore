/**
 * sectionFormRegistry — Item 18 Phase 2.
 *
 *   kind → form-component map. The TS-enforced `Record` ensures every
 *   `HomepageSectionKind` has exactly one form. Add a kind in
 *   `homepageSchemas.ts` → TS errors here until you wire the form.
 */
import type { HomepageSectionKind } from '@/lib/cms/homepageSchemas';
import type { SectionFormProps } from './types';

import HeroSectionForm from './HeroSectionForm';
import FeaturedBrandsSectionForm from './FeaturedBrandsSectionForm';
import TopCategoriesSectionForm from './TopCategoriesSectionForm';
import ProductCollectionSectionForm from './ProductCollectionSectionForm';
import WidePromoBannerSectionForm from './WidePromoBannerSectionForm';
import DualPromoCardsSectionForm from './DualPromoCardsSectionForm';
import BrandShowcaseSectionForm from './BrandShowcaseSectionForm';
import StoreMetricsSectionForm from './StoreMetricsSectionForm';
import WhyShopWithUsSectionForm from './WhyShopWithUsSectionForm';
import BranchesSectionForm from './BranchesSectionForm';
import NewsletterSectionForm from './NewsletterSectionForm';
import MostRatedProductsSectionForm from './MostRatedProductsSectionForm';
import TrendingProductsSectionForm from './TrendingProductsSectionForm';

export const SECTION_FORM_COMPONENTS: Record<HomepageSectionKind, (props: SectionFormProps) => JSX.Element> = {
  HERO:                HeroSectionForm,
  FEATURED_BRANDS:     FeaturedBrandsSectionForm,
  TOP_CATEGORIES:      TopCategoriesSectionForm,
  PRODUCT_COLLECTION:  ProductCollectionSectionForm,
  WIDE_PROMO_BANNER:   WidePromoBannerSectionForm,
  DUAL_PROMO_CARDS:    DualPromoCardsSectionForm,
  BRAND_SHOWCASE:      BrandShowcaseSectionForm,
  STORE_METRICS:       StoreMetricsSectionForm,
  WHY_SHOP_WITH_US:    WhyShopWithUsSectionForm,
  BRANCHES:            BranchesSectionForm,
  NEWSLETTER:          NewsletterSectionForm,
  MOST_RATED_PRODUCTS: MostRatedProductsSectionForm,
  TRENDING_PRODUCTS:   TrendingProductsSectionForm,
};

export const SECTION_KIND_LABELS: Record<HomepageSectionKind, string> = {
  HERO:                'Hero carousel',
  FEATURED_BRANDS:     'Featured brands strip',
  TOP_CATEGORIES:      'Top categories grid',
  PRODUCT_COLLECTION:  'Product collection',
  WIDE_PROMO_BANNER:   'Wide promo banner',
  DUAL_PROMO_CARDS:    'Dual promo cards',
  BRAND_SHOWCASE:      'Brand showcase',
  STORE_METRICS:       'Store metrics',
  WHY_SHOP_WITH_US:    'Why shop with us',
  BRANCHES:            'Store branches',
  NEWSLETTER:          'Newsletter signup',
  MOST_RATED_PRODUCTS: 'Most-rated products',
  TRENDING_PRODUCTS:   'Trending products',
};

export const SECTION_KIND_DESCRIPTIONS: Record<HomepageSectionKind, string> = {
  HERO:                'Full-width banner carousel managed in Hero carousel admin.',
  FEATURED_BRANDS:     'Horizontal strip of brand logos.',
  TOP_CATEGORIES:      'Shop-by-category tile grid.',
  PRODUCT_COLLECTION:  'A flexible product grid — featured / newest / by category / by brand / hand-picked.',
  WIDE_PROMO_BANNER:   'Full-width promotional banner with headline & CTA.',
  DUAL_PROMO_CARDS:    'Two side-by-side promo cards.',
  BRAND_SHOWCASE:      'Discovery band with leading brand logos.',
  STORE_METRICS:       'Stat tiles — "170+ brands", "10M+ customers", etc.',
  WHY_SHOP_WITH_US:    'Trust cards (genuine products, GST billing, …).',
  BRANCHES:            'Map / cards of your physical store locations.',
  NEWSLETTER:          'Email capture block with inline subscribe form.',
  MOST_RATED_PRODUCTS: 'Product collection pre-locked to top_rated mode.',
  TRENDING_PRODUCTS:   'Product collection pre-locked to trending mode.',
};
