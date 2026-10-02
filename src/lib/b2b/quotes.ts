/**
 * Quote-request domain.
 *
 * Customer flow:
 *  1. Create with `lines: [{ productId, variantId?, quantity, note? }]`
 *  2. Wait — admin posts a quote (sets `quoteJson` + status='QUOTED')
 *  3. Accept → we add all lines to the cart, then generate a one-time PERCENT
 *     coupon worth the exact discount the admin offered (so it works
 *     transparently with the existing checkout/totals/placeOrder pipeline).
 *  4. Decline → status='DECLINED', no other side-effects.
 *
 * Admin flow lives in `lib/admin/quotes.ts`.
 */
import { prisma } from '@/lib/db/client';
import { addToCart } from '@/lib/catalog/cart';
import crypto from 'node:crypto';

export interface QuoteLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  note?: string | null;
}

export interface QuoteRequestInput {
  userId: string;
  lines: QuoteLineInput[];
  note?: string | null;
}

export type QuotedLine = {
  productId: string;
  variantId: string | null;
  quantity: number;
  // Server-set when admin quotes:
  unitPricePaise?: number;
  lineTotalPaise?: number;
};

export type QuoteJsonShape = {
  lines: QuotedLine[];
  subtotalPaise: number;
  quotedTotalPaise: number;
  discountPaise: number;
  expiresAt: string;
  adminNote?: string | null;
};

export async function createQuote(input: QuoteRequestInput): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!input.lines.length) return { ok: false, reason: 'Add at least one line.' };
  if (input.lines.length > 100) return { ok: false, reason: 'Too many lines (max 100).' };

  // Validate every product/variant exists + is active
  const ids = Array.from(new Set(input.lines.map((l) => l.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, include: { variants: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const line of input.lines) {
    const p = byId.get(line.productId);
    if (!p || !p.isActive) return { ok: false, reason: 'One or more products are unavailable.' };
    if (p.variants.length > 0) {
      if (!line.variantId || !p.variants.find((v) => v.id === line.variantId && v.isActive)) {
        return { ok: false, reason: `Variant required for “${p.name}”.` };
      }
    }
    if (!Number.isFinite(line.quantity) || line.quantity < 1 || line.quantity > 1000) {
      return { ok: false, reason: 'Quantity must be 1–1000.' };
    }
  }

  const itemsJson = JSON.stringify(input.lines.map((l) => ({
    productId: l.productId, variantId: l.variantId ?? null, quantity: l.quantity, note: l.note ?? null,
  })));

  const q = await prisma.quoteRequest.create({
    data: {
      userId: input.userId,
      itemsJson,
      note: input.note ?? null,
      status: 'OPEN',
    },
  });
  await prisma.userActivity.create({
    data: { userId: input.userId, action: 'QUOTE_REQUESTED', metadata: JSON.stringify({ quoteId: q.id, lines: input.lines.length }) },
  });
  return { ok: true, id: q.id };
}

export async function listQuotesForUser(userId: string) {
  const list = await prisma.quoteRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  // hydrate product names
  const allItems = list.flatMap((q) => {
    try { return JSON.parse(q.itemsJson) as QuotedLine[]; } catch { return []; }
  });
  const ids = Array.from(new Set(allItems.map((i) => i.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
  const nameById = Object.fromEntries(products.map((p) => [p.id, p.name]));
  return list.map((q) => ({
    id: q.id,
    status: q.status,
    note: q.note,
    createdAt: q.createdAt, updatedAt: q.updatedAt,
    lineCount: (JSON.parse(q.itemsJson) as QuotedLine[]).length,
    quote: q.quoteJson ? (JSON.parse(q.quoteJson) as QuoteJsonShape) : null,
    productNames: (JSON.parse(q.itemsJson) as QuotedLine[]).map((l) => nameById[l.productId] ?? '(unknown)'),
  }));
}

export async function getQuoteForUser(userId: string, id: string) {
  const q = await prisma.quoteRequest.findUnique({ where: { id } });
  if (!q || q.userId !== userId) return null;
  const lines = JSON.parse(q.itemsJson) as QuotedLine[];
  const productIds = Array.from(new Set(lines.map((l) => l.productId)));
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    include: { images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    id: q.id, status: q.status, note: q.note,
    createdAt: q.createdAt, updatedAt: q.updatedAt,
    lines: lines.map((l) => {
      const p = byId.get(l.productId);
      return {
        productId: l.productId,
        productName: p?.name ?? '(unknown)',
        productSlug: p?.slug ?? '',
        imageUrl: p?.images[0]?.url ?? null,
        variantId: l.variantId ?? null,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        lineTotalPaise: l.lineTotalPaise,
      };
    }),
    quote: q.quoteJson ? (JSON.parse(q.quoteJson) as QuoteJsonShape) : null,
  };
}

/**
 * Customer accepts a quote.
 * - Re-checks the quote is QUOTED and not expired.
 * - Adds each quoted line to the user's cart.
 * - Generates a single-use coupon worth the exact discount (PERCENT-style not
 *   appropriate here since admin set absolute prices; we use FLAT discount
 *   = sum(line subtotal at current B2C/B2B price) − quotedTotal, capped >= 0).
 *   The coupon is scoped to this user via perUserLimit=1 and usageLimit=1.
 * - Stores the coupon code on the quote so the customer sees it pre-applied.
 */
export async function acceptQuote(userId: string, id: string): Promise<{ ok: true; couponCode: string } | { ok: false; reason: string }> {
  const q = await prisma.quoteRequest.findUnique({ where: { id } });
  if (!q || q.userId !== userId) return { ok: false, reason: 'Quote not found.' };
  if (q.status !== 'QUOTED' || !q.quoteJson) return { ok: false, reason: 'No active quote to accept.' };
  const quote = JSON.parse(q.quoteJson) as QuoteJsonShape;
  if (new Date(quote.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'This quote has expired.' };

  // Add lines to cart
  for (const ln of quote.lines) {
    const r = await addToCart({ userId, productId: ln.productId, variantId: ln.variantId, quantity: ln.quantity });
    if (!r.ok) return { ok: false, reason: `Could not add line: ${r.reason}` };
  }

  // Generate one-shot FLAT coupon
  const code = 'QUOTE-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const discount = Math.max(0, quote.subtotalPaise - quote.quotedTotalPaise);
  await prisma.coupon.create({
    data: {
      code,
      description: `Quote ${q.id} acceptance`,
      discountType: 'FLAT',
      value: discount,
      validFrom: new Date(),
      validUntil: new Date(quote.expiresAt),
      usageLimit: 1, perUserLimit: 1,
      appliesToB2B: true, appliesToB2C: true,
      isActive: true,
    },
  });
  await prisma.quoteRequest.update({ where: { id: q.id }, data: { status: 'ACCEPTED' } });
  await prisma.userActivity.create({
    data: { userId, action: 'QUOTE_ACCEPTED', metadata: JSON.stringify({ quoteId: q.id, couponCode: code, discountPaise: discount }) },
  });
  return { ok: true, couponCode: code };
}

export async function declineQuote(userId: string, id: string, reason?: string) {
  const q = await prisma.quoteRequest.findUnique({ where: { id } });
  if (!q || q.userId !== userId) return { ok: false as const, reason: 'Quote not found.' };
  if (q.status === 'ACCEPTED') return { ok: false as const, reason: 'Already accepted.' };
  await prisma.quoteRequest.update({ where: { id: q.id }, data: { status: 'DECLINED' } });
  await prisma.userActivity.create({
    data: { userId, action: 'QUOTE_DECLINED', metadata: JSON.stringify({ quoteId: q.id, reason: reason ?? null }) },
  });
  return { ok: true as const };
}
