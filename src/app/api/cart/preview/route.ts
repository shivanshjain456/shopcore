/**
 * POST /api/cart/preview  — guest-mode preview.
 *
 * Takes a list of {productId, variantId, quantity} from localStorage and returns
 * a fully-priced cart view WITHOUT persisting anything. Prices are computed
 * server-side so the client can't lie about them.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { prisma } from '@/lib/db/client';
import { effectivePricePaise, mrpPaise, priceCtxForUser } from '@/lib/catalog/pricing';
import { MAX_QTY_PER_LINE, type CartLineView, type CartView } from '@/lib/catalog/cart';
import { serializeCartForApi } from '@/lib/catalog/cartView';

export const dynamic = 'force-dynamic';

// .strict() — preview prices come from DB; client may only send id+qty.
const Body = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    variantId: z.string().nullable().optional(),
    quantity:  z.number().int().min(1).max(MAX_QTY_PER_LINE),
  }).strict()).max(50),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  const { items } = Body.parse(await req.json());
  if (items.length === 0) {
    return jsonOk(serializeCartForApi({
      id: null, items: [], itemCount: 0, unitCount: 0,
      subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0,
    }));
  }

  // Guest preview uses the public B2C pricing (no user)
  const ctx = priceCtxForUser(null);

  const productIds = Array.from(new Set(items.map((i) => i.productId)));
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    include: {
      images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      variants: true,
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines: CartLineView[] = [];
  items.forEach((it, idx) => {
    const p = byId.get(it.productId);
    if (!p) return;
    let variant: typeof p.variants[number] | null = null;
    if (it.variantId) variant = p.variants.find((v) => v.id === it.variantId) ?? null;
    if (p.variants.length > 0 && !variant) return; // require valid variant
    // Surface the requested quantity AS-IS so the UI can warn the user;
    // never silently shrink it to "appear" in stock. The `inStock` flag
    // (qty ≤ stock AND active) is the authoritative signal for checkout.
    const rawStock = variant ? variant.stock : p.stock;
    const stock = rawStock === null || rawStock === undefined || rawStock < 0 ? 0 : rawStock;
    const unit = effectivePricePaise(variant ?? p, ctx);
    const mrp  = mrpPaise(variant ?? p);
    const qty  = it.quantity;
    const active = p.isActive && (variant ? variant.isActive : true);
    lines.push({
      id: String(idx),                   // guest "itemId" is the index in the local list
      productId: p.id,
      variantId: variant?.id ?? null,
      productName: p.name,
      variantName: variant?.name ?? null,
      slug: p.slug,
      imageUrl: p.images[0]?.url ?? null,
      unitPricePaise: unit,
      mrpPaise: mrp,
      quantity: qty,
      lineTotalPaise: unit * qty,
      stock,
      inStock: active && stock > 0 && qty <= stock,
    });
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const mrpTotal = lines.reduce((s, l) => s + l.mrpPaise * l.quantity, 0);

  const view: CartView = {
    id: null, items: lines,
    itemCount: lines.length,
    unitCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotalPaise: subtotal,
    mrpTotalPaise: mrpTotal,
    savingsPaise: Math.max(0, mrpTotal - subtotal),
  };

  return jsonOk(serializeCartForApi(view));
});
