import { jsonOk, withErrorHandling } from '@/lib/api';
import { getBrands } from '@/lib/catalog/queries';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const brands = await getBrands();
  // Item 17 — surface brand assets (logoUrl + description) so storefront
  //   consumers (homepage brand band, search filter chips) can render
  //   real logos. Banner is admin-only for now.
  return jsonOk({ brands: brands.map((b) => ({
    id:          b.id,
    name:        b.name,
    slug:        b.slug,
    logoUrl:     b.logoUrl ?? null,
    description: b.description ?? null,
  })) });
});
