/**
 * Asset health computation — Item 17 Phase 2.
 *
 *   Powers the /admin/assets dashboard. Computes coverage stats
 *   across three surfaces:
 *
 *     1. Store identity   — store.{logoUrl, faviconUrl, ogImageUrl,
 *                           appIconUrl, logoDarkUrl} from store config.
 *     2. Brands           — Brand.{logoUrl, bannerUrl, description}.
 *     3. Categories       — Category.{imageUrl, bannerUrl, iconUrl,
 *                           description}.
 *
 *   No caching — admin-only, infrequent reads, all DB-bound. The full
 *   set fits in a single round trip per surface.
 */
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/storeConfig';

// ── Types ────────────────────────────────────────────────────────────────

export interface StoreIdentityCoverage {
  logoUrl:     { configured: boolean; url: string | null };
  logoDarkUrl: { configured: boolean; url: string | null };
  faviconUrl:  { configured: boolean; url: string | null };
  ogImageUrl:  { configured: boolean; url: string | null };
  appIconUrl:  { configured: boolean; url: string | null };
  total:       number;
  configured:  number;
}

export interface BrandRowHealth {
  id:          string;
  name:        string;
  slug:        string;
  logoUrl:     string | null;
  bannerUrl:   string | null;
  description: string | null;
}

export interface BrandHealth {
  total:          number;
  withLogo:       number;
  withBanner:     number;
  withDescription:number;
  brands:         BrandRowHealth[];
}

export interface CategoryRowHealth {
  id:          string;
  name:        string;
  slug:        string;
  imageUrl:    string | null;
  bannerUrl:   string | null;
  iconUrl:     string | null;
  description: string | null;
}

export interface CategoryHealth {
  total:           number;
  withImage:       number;
  withBanner:      number;
  withIcon:        number;
  withDescription: number;
  categories:      CategoryRowHealth[];
}

// ── Computation ──────────────────────────────────────────────────────────

function present(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

export async function getStoreIdentityHealth(): Promise<StoreIdentityCoverage> {
  const cfg = await getStoreConfig();
  const store = (cfg as { store?: Record<string, unknown> }).store ?? {};
  const read = (k: string): string | null => {
    const v = store[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  const slots: Array<keyof StoreIdentityCoverage> = [
    'logoUrl', 'logoDarkUrl', 'faviconUrl', 'ogImageUrl', 'appIconUrl',
  ];
  let configured = 0;
  const out: Partial<StoreIdentityCoverage> = {};
  for (const key of slots) {
    const url = read(key);
    if (url !== null) configured++;
    out[key] = { configured: url !== null, url } as never;
  }
  out.total = slots.length;
  out.configured = configured;
  return out as StoreIdentityCoverage;
}

export async function getBrandHealth(): Promise<BrandHealth> {
  // PAGINATION-EXEMPT: brand table is a small lookup; coverage view
  //   needs the full set to render the per-brand grid.
  const rows = await prisma.brand.findMany({
    where:   { isActive: true },
    orderBy: { name: 'asc' },
    select:  { id: true, name: true, slug: true, logoUrl: true, bannerUrl: true, description: true },
  });
  let withLogo = 0, withBanner = 0, withDescription = 0;
  for (const r of rows) {
    if (present(r.logoUrl))     withLogo++;
    if (present(r.bannerUrl))   withBanner++;
    if (present(r.description)) withDescription++;
  }
  return {
    total: rows.length,
    withLogo, withBanner, withDescription,
    brands: rows,
  };
}

export async function getCategoryHealth(): Promise<CategoryHealth> {
  // PAGINATION-EXEMPT: same reasoning as brands.
  const rows = await prisma.category.findMany({
    where:   { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select:  {
      id: true, name: true, slug: true,
      imageUrl: true, bannerUrl: true, iconUrl: true, description: true,
    },
  });
  let withImage = 0, withBanner = 0, withIcon = 0, withDescription = 0;
  for (const r of rows) {
    if (present(r.imageUrl))    withImage++;
    if (present(r.bannerUrl))   withBanner++;
    if (present(r.iconUrl))     withIcon++;
    if (present(r.description)) withDescription++;
  }
  return {
    total: rows.length,
    withImage, withBanner, withIcon, withDescription,
    categories: rows,
  };
}
