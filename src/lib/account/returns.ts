/**
 * Returns / Exchanges eligibility + creation.
 *
 * Rules come from StoreConfig.policies.returns / exchanges:
 *   - windowDays: must be within N days of `deliveredAt` (or `createdAt` if no deliveredAt)
 *   - excludedCategories: by category SLUG
 *   - requirePhotos: at least one image
 *   - restockingFeePercent: applied to refund amount on RETURN
 *
 * For RETURN / REFUND_ONLY the refund amount is computed = unit*qty - restocking fee.
 * For EXCHANGE the refund amount is null (handled when admin ships exchange).
 */
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import type { ReturnType } from '@/lib/enums';

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  windowEndsAt?: Date;
  excludedCategorySlugs?: string[];
}

export async function checkOrderEligibility(userId: string, orderId: string): Promise<EligibilityResult> {
  const cfg = await getStoreConfig();
  if (!cfg.policies.returns.enabled && !cfg.policies.exchanges.enabled) {
    return { eligible: false, reason: 'Returns and exchanges are currently disabled.' };
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: { include: { category: true } } } } },
  });
  if (!order || order.userId !== userId) return { eligible: false, reason: 'Order not found.' };
  if (order.status !== 'DELIVERED' && order.status !== 'SHIPPED' && order.status !== 'OUT_FOR_DELIVERY') {
    return { eligible: false, reason: 'Returns are allowed only after delivery.' };
  }
  const since = order.deliveredAt ?? order.createdAt;
  const windowDays = Math.max(cfg.policies.returns.windowDays, cfg.policies.exchanges.windowDays);
  const windowEndsAt = new Date(since.getTime() + windowDays * 86400_000);
  if (Date.now() > windowEndsAt.getTime()) {
    return { eligible: false, reason: `Return window of ${windowDays} days has passed.`, windowEndsAt };
  }
  return {
    eligible: true,
    windowEndsAt,
    excludedCategorySlugs: cfg.policies.returns.excludedCategories,
  };
}

export interface CreateReturnInput {
  userId: string;
  orderId: string;
  type: ReturnType;             // RETURN | EXCHANGE | REFUND_ONLY
  reason: string;
  details?: string | null;
  items: { orderItemId: string; quantity: number }[];
  imageUrls?: string[];
}

export type CreateReturnResult = { ok: true; id: string } | { ok: false; reason: string };

export async function createReturn(input: CreateReturnInput): Promise<CreateReturnResult> {
  const cfg = await getStoreConfig();
  const elig = await checkOrderEligibility(input.userId, input.orderId);
  if (!elig.eligible) return { ok: false, reason: elig.reason ?? 'Not eligible.' };

  if (cfg.policies.returns.requirePhotos && (!input.imageUrls || input.imageUrls.length === 0)) {
    return { ok: false, reason: 'Please attach at least one photo.' };
  }
  if (!input.items || input.items.length === 0) return { ok: false, reason: 'Pick at least one item.' };

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { items: { include: { product: { include: { category: true } } } } },
    });
    if (!order) return { ok: false as const, reason: 'Order not found.' };

    let refund = 0;
    const itemsJson: Array<{ orderItemId: string; productName: string; variantName: string | null; quantity: number; unitPricePaise: number }> = [];

    for (const sel of input.items) {
      const oi = order.items.find((x) => x.id === sel.orderItemId);
      if (!oi) return { ok: false as const, reason: 'Item not in this order.' };
      if (sel.quantity < 1 || sel.quantity > oi.quantity) {
        return { ok: false as const, reason: `Invalid quantity for ${oi.productName}.` };
      }
      const excluded = elig.excludedCategorySlugs ?? [];
      if (excluded.includes(oi.product.category.slug)) {
        return { ok: false as const, reason: `${oi.product.category.name} is excluded from returns.` };
      }
      refund += oi.unitPricePaise * sel.quantity;
      itemsJson.push({
        orderItemId: oi.id, productName: oi.productName, variantName: oi.variantName,
        quantity: sel.quantity, unitPricePaise: oi.unitPricePaise,
      });
    }

    // Apply restocking fee on RETURN/REFUND_ONLY (not on EXCHANGE)
    let refundAmount: number | null = refund;
    if (input.type === 'EXCHANGE') {
      refundAmount = null;
    } else if (cfg.policies.returns.restockingFeePercent > 0) {
      refundAmount = Math.max(0, Math.round(refund * (1 - cfg.policies.returns.restockingFeePercent / 100)));
    }

    const created = await tx.returnRequest.create({
      data: {
        orderId: input.orderId,
        userId: input.userId,
        type: input.type,
        reason: input.reason,
        details: input.details ?? null,
        itemsJson: JSON.stringify(itemsJson),
        imagesJson: input.imageUrls ? JSON.stringify(input.imageUrls) : null,
        refundAmountPaise: refundAmount,
      },
    });

    await tx.userActivity.create({
      data: { userId: input.userId, action: 'RETURN_REQUESTED', metadata: JSON.stringify({ returnId: created.id, orderId: input.orderId, type: input.type }) },
    });

    return { ok: true as const, id: created.id };
  });
}
