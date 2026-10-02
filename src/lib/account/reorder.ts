/**
 * Re-create a user's current cart from a past order.
 * Skips items where the product/variant is no longer active or fully out of stock,
 * and returns a `skipped[]` list so the UI can surface them.
 */
import { prisma } from '@/lib/db/client';
import { addToCart } from '@/lib/catalog/cart';

export interface ReorderResult {
  ok: true;
  added: { productId: string; variantId: string | null; quantity: number; name: string }[];
  skipped: { productId: string; variantId: string | null; name: string; reason: string }[];
}

export async function reorderFromOrder(userId: string, orderId: string): Promise<ReorderResult | { ok: false; reason: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true, variant: true } } },
  });
  if (!order || order.userId !== userId) return { ok: false, reason: 'Order not found.' };

  const added: ReorderResult['added'] = [];
  const skipped: ReorderResult['skipped'] = [];

  for (const it of order.items) {
    if (!it.product.isActive) {
      skipped.push({ productId: it.productId, variantId: it.variantId, name: it.productName, reason: 'No longer available' });
      continue;
    }
    if (it.variant && !it.variant.isActive) {
      skipped.push({ productId: it.productId, variantId: it.variantId, name: `${it.productName} · ${it.variantName ?? ''}`, reason: 'Variant unavailable' });
      continue;
    }
    const r = await addToCart({
      userId,
      productId: it.productId,
      variantId: it.variantId,
      quantity: it.quantity,
    });
    if (r.ok) {
      added.push({ productId: it.productId, variantId: it.variantId, quantity: r.line.quantity, name: it.productName + (it.variantName ? ' · ' + it.variantName : '') });
    } else {
      skipped.push({ productId: it.productId, variantId: it.variantId, name: it.productName, reason: r.reason });
    }
  }

  return { ok: true, added, skipped };
}
