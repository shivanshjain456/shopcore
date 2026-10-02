import { jsonOk, withErrorHandling } from '@/lib/api';
import { getCategoriesWithCounts } from '@/lib/catalog/queries';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const cats = await getCategoriesWithCounts();
  return jsonOk({
    // Item 17 — include asset URLs so the storefront homepage can
    //   render real tile images / nav icons. <CategoryImage> falls
    //   back when these are null.
    categories: cats.map((c) => ({
      id: c.id, name: c.name, slug: c.slug,
      imageUrl:    (c as { imageUrl?: string | null }).imageUrl    ?? null,
      bannerUrl:   (c as { bannerUrl?: string | null }).bannerUrl   ?? null,
      iconUrl:     (c as { iconUrl?: string | null }).iconUrl       ?? null,
      description: (c as { description?: string | null }).description ?? null,
      productCount: (c as { _count?: { products: number } })._count?.products ?? 0,
    })),
  });
});
