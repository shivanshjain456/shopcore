/**
 * Admin-side: post a counter-quote to an OPEN QuoteRequest.
 * Caller must have already loaded the admin via requireAdminUser().
 */
import { prisma } from '@/lib/db/client';
import { effectivePricePaise, priceCtxForUser } from '@/lib/catalog/pricing';
import type { QuotedLine, QuoteJsonShape } from '@/lib/b2b/quotes';

export interface AdminQuoteInput {
  quoteId: string;
  lines: Array<{ productId: string; variantId?: string | null; quantity: number; unitPricePaise: number }>;
  validForDays: number;       // typically 7
  adminNote?: string | null;
}

export async function postCounterQuote(input: AdminQuoteInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const q = await prisma.quoteRequest.findUnique({ where: { id: input.quoteId }, include: { user: true } });
  if (!q) return { ok: false, reason: 'Quote not found.' };
  if (q.status !== 'OPEN') return { ok: false, reason: `Quote is ${q.status}; only OPEN quotes can be answered.` };

  // Compute the customer-perspective subtotal (so we can derive the FLAT discount on accept)
  const tier = q.user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: q.user.b2bTierId } }) : null;
  const ctx = priceCtxForUser(q.user, tier);
  const productIds = Array.from(new Set(input.lines.map((l) => l.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, include: { variants: true } });
  const byId = new Map(products.map((p) => [p.id, p]));

  let subtotal = 0;
  let quotedTotal = 0;
  const outLines: QuotedLine[] = [];
  for (const l of input.lines) {
    const p = byId.get(l.productId);
    if (!p || !p.isActive) return { ok: false, reason: 'A quoted product is no longer available.' };
    let priced = effectivePricePaise(p, ctx);
    if (l.variantId) {
      const v = p.variants.find((x) => x.id === l.variantId && x.isActive);
      if (!v) return { ok: false, reason: 'A quoted variant is no longer available.' };
      priced = effectivePricePaise(v, ctx);
    }
    if (!Number.isInteger(l.unitPricePaise) || l.unitPricePaise < 0) return { ok: false, reason: 'Invalid unit price.' };
    if (!Number.isInteger(l.quantity) || l.quantity < 1) return { ok: false, reason: 'Invalid quantity.' };
    subtotal    += priced * l.quantity;
    quotedTotal += l.unitPricePaise * l.quantity;
    outLines.push({
      productId: l.productId, variantId: l.variantId ?? null, quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      lineTotalPaise: l.unitPricePaise * l.quantity,
    });
  }

  const days = Math.min(60, Math.max(1, Math.floor(input.validForDays)));
  const expiresAt = new Date(Date.now() + days * 86400_000);
  const shape: QuoteJsonShape = {
    lines: outLines,
    subtotalPaise: subtotal,
    quotedTotalPaise: quotedTotal,
    discountPaise: Math.max(0, subtotal - quotedTotal),
    expiresAt: expiresAt.toISOString(),
    adminNote: input.adminNote ?? null,
  };
  await prisma.quoteRequest.update({
    where: { id: q.id },
    data: { quoteJson: JSON.stringify(shape), status: 'QUOTED' },
  });
  await prisma.userActivity.create({
    data: { userId: q.userId, action: 'QUOTE_ANSWERED', metadata: JSON.stringify({ quoteId: q.id, quotedTotalPaise: quotedTotal }) },
  });
  return { ok: true };
}
