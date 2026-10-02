import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getProductBySlug } from '@/lib/catalog/queries';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { effectivePricePaise, priceCtxForUser } from '@/lib/catalog/pricing';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_: Request, { params }: { params: { slug: string } }) => {
  const p = await getProductBySlug(params.slug);
  if (!p || !p.isActive) return jsonError('Product not found.', 404);
  const user = await getCurrentUser();
  const tier = user?.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  const ctx = priceCtxForUser(user, tier);

  return jsonOk({
    id: p.id, sku: p.sku, slug: p.slug, name: p.name,
    description: p.description, shortDesc: p.shortDesc,
    category: p.category, brand: p.brand,
    mrpPaise: p.mrpPaise, pricePaise: effectivePricePaise(p, ctx),
    gstRate: p.gstRate, hsnCode: p.hsnCode,
    stock: p.stock,
    images: p.images.map((i) => ({ url: i.url, alt: i.alt })),
    variants: p.variants.map((v) => ({
      id: v.id, sku: v.sku, name: v.name, attributes: v.attributes,
      mrpPaise: v.mrpPaise, pricePaise: effectivePricePaise(v, ctx),
      stock: v.stock,
    })),
  });
});
