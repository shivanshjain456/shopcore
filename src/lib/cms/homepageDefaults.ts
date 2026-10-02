/**
 * Homepage CMS — default seed.
 *
 *   First boot (or admin "Reset homepage") populates `HomepageSection`
 *   with these rows so the storefront renders a sensible default
 *   immediately. Mirrors the structure of the OLD hand-coded homepage
 *   (hero → categories → brands → featured → latest) so existing
 *   visual users see no regression — the admin can then drag, edit,
 *   add, or remove.
 *
 * Pure module — exports an array of section blueprints.
 */
import type { HomepageSectionKind } from './homepageSchemas';

export interface HomepageSectionSeed {
  kind:         HomepageSectionKind;
  slug:         string;
  title:        string | null;
  displayOrder: number;
  isActive:     boolean;
  config:       Record<string, unknown>;
}

export const DEFAULT_HOMEPAGE_SECTIONS: HomepageSectionSeed[] = [
  {
    kind: 'HERO', slug: 'hero', title: 'Hero carousel',
    displayOrder: 10, isActive: true, config: {},
  },
  {
    kind: 'FEATURED_BRANDS', slug: 'featured-brands', title: 'Featured brands strip',
    displayOrder: 20, isActive: true,
    config: { source: 'auto', maxItems: 12, heading: 'Shop by brand', subheading: '' },
  },
  {
    kind: 'TOP_CATEGORIES', slug: 'top-categories', title: 'Top categories',
    displayOrder: 30, isActive: true,
    config: { source: 'auto', maxItems: 10, heading: 'Shop by category', layout: 'tiles' },
  },
  {
    kind: 'PRODUCT_COLLECTION', slug: 'featured-products', title: 'Featured products',
    displayOrder: 40, isActive: true,
    config: {
      heading: 'Featured', subheading: 'Hand-picked products our customers love.',
      theme: 'default', maxItems: 8,
      source: { mode: 'featured' },
      cta: { label: 'See all', href: '/search?sort=relevance' },
    },
  },
  {
    kind: 'MOST_RATED_PRODUCTS', slug: 'most-rated-products', title: 'Most rated products',
    displayOrder: 50, isActive: true,
    config: {
      heading: 'Top rated', subheading: 'Products our customers consistently rave about.',
      theme: 'amber', maxItems: 8,
      source: { mode: 'top_rated', minReviews: 1 },
    },
  },
  {
    kind: 'PRODUCT_COLLECTION', slug: 'latest-arrivals', title: 'Latest arrivals',
    displayOrder: 60, isActive: true,
    config: {
      heading: 'Latest arrivals', subheading: 'Just landed in the catalogue.',
      theme: 'sky', maxItems: 8,
      source: { mode: 'newest' },
    },
  },
  {
    kind: 'STORE_METRICS', slug: 'store-metrics', title: 'Trust metrics',
    displayOrder: 70, isActive: true,
    config: { heading: '', theme: 'slate' },
  },
];

/** Optional default metrics — admin can edit / delete after seed. */
export const DEFAULT_HOMEPAGE_METRICS = [
  { label: 'Years in business',  value: '5+',     caption: 'Trusted since 2020',  displayOrder: 10 },
  { label: 'Customers served',   value: '10K+',   caption: 'Across India',         displayOrder: 20 },
  { label: 'Brands available',   value: '170+',   caption: 'Curated catalogue',    displayOrder: 30 },
  { label: 'Orders delivered',   value: '50K+',   caption: 'And counting',         displayOrder: 40 },
];
