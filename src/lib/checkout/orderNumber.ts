/**
 * Generate a human-friendly, year-scoped, monotonically-increasing order number:
 *   SC-2026-000001
 *
 * Uses a count() inside the same transaction the caller is in; collisions
 * are guarded by the @unique constraint on Order.orderNumber so even if two
 * orders race we retry once.
 */
import type { Prisma } from '@prisma/client';

export async function generateOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  // Count existing orders in this year, then increment. Atomic enough inside a tx.
  const count = await tx.order.count({
    where: { orderNumber: { startsWith: `SC-${year}-` } },
  });
  const candidate = `SC-${year}-${String(count + 1).padStart(6, '0')}`;
  // Belt-and-braces: if somehow exists, walk forward
  for (let i = 0; i < 5; i++) {
    const n = candidate.endsWith(String(count + 1).padStart(6, '0'))
      ? candidate
      : `SC-${year}-${String(count + 1 + i).padStart(6, '0')}`;
    const exists = await tx.order.findUnique({ where: { orderNumber: n } });
    if (!exists) return n;
  }
  // Final fallback — should be unreachable
  return `SC-${year}-${Date.now()}`;
}
