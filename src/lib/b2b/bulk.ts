/**
 * Parse a bulk SKU/qty CSV. Accepts these row shapes (header optional):
 *    sku,qty
 *    LAP-DELL-INSP15-001-V1, 5
 *    ACC-LOG-MX3S-301, 20
 *
 * Variants are matched by Variant.sku; products by Product.sku.
 *
 * Returns a per-row result so the UI can show successes + reasons.
 */
import { prisma } from '@/lib/db/client';
import { addToCart } from '@/lib/catalog/cart';

export interface ParsedRow { sku: string; qty: number; }
export interface BulkRowResult {
  sku: string; qty: number;
  ok: boolean; reason?: string;
  productId?: string; variantId?: string | null; productName?: string;
  addedQty?: number;
}

export function parseBulkCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let startIdx = 0;
  if (lines.length && /sku/i.test(lines[0]) && /qty/i.test(lines[0])) startIdx = 1;
  for (let i = startIdx; i < lines.length && rows.length < 500; i++) {
    const parts = lines[i].split(/[,\t]/).map((s) => s.trim());
    if (parts.length < 2) continue;
    const sku = parts[0].toUpperCase();
    const qty = Math.floor(Number(parts[1]));
    if (!sku || !Number.isFinite(qty) || qty < 1) continue;
    rows.push({ sku, qty });
  }
  return rows;
}

export async function bulkAddToCart(userId: string, rows: ParsedRow[]): Promise<BulkRowResult[]> {
  const results: BulkRowResult[] = [];

  // Resolve every SKU (variant first, then product)
  const skus = Array.from(new Set(rows.map((r) => r.sku)));
  const variants = await prisma.variant.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true, productId: true, isActive: true, product: { select: { id: true, name: true, isActive: true } } },
  });
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true, name: true, isActive: true },
  });
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));
  const productBySku = new Map(products.map((p) => [p.sku, p]));

  for (const row of rows) {
    const v = variantBySku.get(row.sku);
    if (v) {
      if (!v.isActive || !v.product.isActive) {
        results.push({ ...row, ok: false, reason: 'Inactive', productName: v.product.name }); continue;
      }
      const r = await addToCart({ userId, productId: v.productId, variantId: v.id, quantity: row.qty });
      if (r.ok) results.push({ ...row, ok: true, productId: v.productId, variantId: v.id, productName: v.product.name, addedQty: r.line.quantity });
      else      results.push({ ...row, ok: false, reason: r.reason, productName: v.product.name });
      continue;
    }
    const p = productBySku.get(row.sku);
    if (p) {
      if (!p.isActive) { results.push({ ...row, ok: false, reason: 'Inactive', productName: p.name }); continue; }
      const r = await addToCart({ userId, productId: p.id, variantId: null, quantity: row.qty });
      if (r.ok) results.push({ ...row, ok: true, productId: p.id, productName: p.name, addedQty: r.line.quantity });
      else      results.push({ ...row, ok: false, reason: r.reason, productName: p.name });
      continue;
    }
    results.push({ ...row, ok: false, reason: 'SKU not found' });
  }
  return results;
}
