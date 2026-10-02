/**
 * Admin order operations.
 *  - verifyPayment(): paymentStatus VERIFIED, status PAYMENT_VERIFIED → PROCESSING,
 *      credits the previously-pending loyalty earn into the User balance.
 *  - rejectPayment(): paymentStatus REJECTED with note, optionally restore stock.
 *  - setShipping(): set courier + tracking; status flips to SHIPPED if not already past.
 *  - advanceStatus(): explicit status transitions (PROCESSING → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED).
 *  - adminRefund(): paymentStatus REFUNDED, status REFUNDED; restores stock + reverses loyalty.
 *  All write an OrderStatusHistory row + AuditLog row (audit is added by the API route layer).
 *
 * Transactions use { timeout: 15_000 } because SQLite + multi-step writes can
 * exceed the 5 s default under cold-start latency.
 */
import { prisma } from '@/lib/db/client';
import { adjustLoyalty } from '@/lib/account/loyalty';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { computeEarnedPoints, toLoyaltyConfig } from '@/lib/account/loyaltyFormula';

const TX_OPTS = { maxWait: 5000, timeout: 15000 } as const;

/**
 * Admin payment-verification. The admin must positively attest that the bank
 * statement (or UPI ledger screenshot) shows an INCOMING credit for THIS
 * order's `totalPaise` AND that the UTR on the order matches the bank's UTR.
 *
 * `attestation.amountMatches` is required to be `true` — passing `false` (or
 * omitting it) makes this a no-op rejection. This is a hard policy: an admin
 * cannot accidentally one-click-verify a payment without consciously checking
 * the amount, which is the most common source of partial-payment fraud.
 */
export interface VerifyPaymentAttestation {
  amountMatches: boolean;        // must be true; partial-payment guard
  bankReference?: string | null; // optional: the UTR from the bank's side, for cross-check
}

export async function verifyPayment(
  adminId: string,
  orderId: string,
  note?: string | null,
  attestation?: VerifyPaymentAttestation,
) {
  if (!attestation || attestation.amountMatches !== true) {
    return {
      ok: false as const,
      reason: 'Refusing to verify: admin must attest that the bank-statement amount matches the order total (amountMatches=true). Re-check the bank entry and resubmit.',
    };
  }

  return prisma.$transaction(async (tx) => {
    // Locking read: SQLite serialises writes, and the immediate `update()` below
    // takes the write lock for this row, so a concurrent verify call on the
    // same orderId will block until this transaction commits — at which point
    // the second caller sees paymentStatus='VERIFIED' and exits via the guard.
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false as const, reason: 'Order not found.' };
    if (order.paymentStatus === 'VERIFIED') return { ok: false as const, reason: 'Payment already verified.' };
    if (!order.utrNumber) return { ok: false as const, reason: 'Order has no UTR on record; cannot verify.' };
    if (!order.receiptUrl) return { ok: false as const, reason: 'Order has no payment receipt on record; cannot verify.' };

    // If the admin supplied a bank-side reference, it MUST match the UTR
    // we stored when the order was placed (after sanitisation). Mismatch
    // is a hard rejection — the UTR the customer typed isn't the one that
    // landed in the bank.
    if (attestation.bankReference) {
      // Inline sanitiser (mirror of lib/checkout/utr.ts:sanitizeUtr)
      const bankSan = String(attestation.bankReference).trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (bankSan !== order.utrNumber) {
        return {
          ok: false as const,
          reason: `Bank-statement UTR (${bankSan}) does not match the UTR on this order (${order.utrNumber}). Reject the payment instead of verifying it.`,
        };
      }
    }

    // Idempotency: if an ORDER_CREDIT ledger row already exists for this order,
    // we MUST NOT credit again (prevents double-credit on retry / race).
    const alreadyCredited = await tx.loyaltyLedger.findFirst({
      where: { userId: order.userId, reason: 'ORDER_CREDIT', refId: order.id },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'VERIFIED',
        paymentVerifiedAt: new Date(),
        paymentVerifiedBy: adminId,
        paymentRejectReason: null,
        amountVerifiedAt: new Date(),
        status: order.status === 'PENDING_PAYMENT_REVIEW' ? 'PROCESSING' : order.status,
      },
    });
    // Update the UtrSubmission row in lock-step with the order.
    if (order.utrNumber) {
      await tx.utrSubmission.updateMany({
        where: { utrNormalized: order.utrNumber, orderId: order.id },
        data:  { status: 'VERIFIED', verifiedAt: new Date(), verifiedBy: adminId },
      });
    }
    await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'PAYMENT_VERIFIED', note: note ?? 'Payment verified by admin', changedBy: adminId } });
    if (order.status === 'PENDING_PAYMENT_REVIEW') {
      await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'PROCESSING', note: null, changedBy: adminId } });
    }

    if (!alreadyCredited) {
      // Determine earn from the snapshot on the order (single source of truth,
      // immune to formula changes between placement and verification).
      let pointsToCredit = order.loyaltyPointsEarned ?? 0;

      // Back-compat: if a legacy order was placed before the snapshot column
      // existed, fall back to RE-COMPUTING with the CURRENT formula — never to
      // the old hardcoded math.
      if (pointsToCredit === 0 && !order.loyaltyFormulaSnapshot) {
        const cfg = await getStoreConfig();
        const conf = toLoyaltyConfig(cfg.loyalty as unknown as Record<string, unknown>);
        const recomputed = computeEarnedPoints(conf, {
          subtotalPaise: order.subtotalPaise, discountPaise: order.discountPaise,
        });
        pointsToCredit = recomputed.points;
      }

      // Clean up the pending marker either way (zero-delta row from placement)
      const pending = await tx.loyaltyLedger.findFirst({ where: { userId: order.userId, reason: 'ORDER_PENDING', refId: order.id } });
      if (pending) await tx.loyaltyLedger.delete({ where: { id: pending.id } });

      if (pointsToCredit > 0) {
        await adjustLoyalty(tx, order.userId, pointsToCredit, 'ORDER_CREDIT', order.id);
      }
    }

    return { ok: true as const };
  }, TX_OPTS);
}

export async function rejectPayment(adminId: string, orderId: string, reason: string, restoreStock = true) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return { ok: false as const, reason: 'Order not found.' };
    if (order.paymentStatus === 'REJECTED') return { ok: false as const, reason: 'Already rejected.' };
    if (order.paymentStatus === 'VERIFIED') return { ok: false as const, reason: 'Cannot reject a verified payment; refund instead.' };

    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'REJECTED', paymentRejectReason: reason, status: 'PAYMENT_REJECTED' },
    });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'PAYMENT_REJECTED', note: reason, changedBy: adminId } });

    if (restoreStock) {
      for (const li of order.items) {
        if (li.variantId) await tx.variant.update({ where: { id: li.variantId }, data: { stock: { increment: li.quantity } } });
        else              await tx.product.update({ where: { id: li.productId }, data: { stock: { increment: li.quantity } } });
        await tx.inventoryLog.create({ data: { productId: li.productId, variantId: li.variantId, delta: li.quantity, reason: 'PAYMENT_REJECT', refId: order.id, performedBy: adminId } });
      }
    }
    await tx.loyaltyLedger.deleteMany({ where: { userId: order.userId, reason: 'ORDER_PENDING', refId: order.id } });
    return { ok: true as const };
  }, TX_OPTS);
}

export async function setShipping(adminId: string, orderId: string, courierName: string, trackingNumber?: string | null, trackingUrl?: string | null) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false as const, reason: 'Order not found.' };
  if (order.paymentStatus !== 'VERIFIED') return { ok: false as const, reason: 'Verify payment first.' };
  const wasShipped = order.status === 'SHIPPED' || order.status === 'OUT_FOR_DELIVERY' || order.status === 'DELIVERED';
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        courierName, trackingNumber: trackingNumber ?? null, trackingUrl: trackingUrl ?? null,
        shippedAt: order.shippedAt ?? new Date(),
        status: wasShipped ? order.status : 'SHIPPED',
      },
    });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, status: wasShipped ? order.status : 'SHIPPED', note: `Courier: ${courierName}${trackingNumber ? ' #' + trackingNumber : ''}`, changedBy: adminId } });
  }, TX_OPTS);
  return { ok: true as const };
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PAYMENT_VERIFIED:  ['PROCESSING'],
  PROCESSING:        ['PACKED', 'CANCELLED'],
  PACKED:            ['SHIPPED', 'CANCELLED'],
  SHIPPED:           ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY:  ['DELIVERED'],
};

export async function advanceStatus(adminId: string, orderId: string, to: string, note?: string | null) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false as const, reason: 'Order not found.' };
  const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(to)) return { ok: false as const, reason: `Cannot move ${order.status} → ${to}.` };
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: to,
        ...(to === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        ...(to === 'SHIPPED' && !order.shippedAt ? { shippedAt: new Date() } : {}),
      },
    });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, status: to, note: note ?? null, changedBy: adminId } });
  }, TX_OPTS);
  return { ok: true as const };
}

export async function adminRefund(adminId: string, orderId: string, reason: string, restoreStock = true) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return { ok: false as const, reason: 'Order not found.' };
    if (order.paymentStatus === 'REFUNDED') return { ok: false as const, reason: 'Already refunded.' };

    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'REFUNDED', status: 'REFUNDED', paymentRejectReason: reason } });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'REFUNDED', note: reason, changedBy: adminId } });

    if (restoreStock) {
      for (const li of order.items) {
        if (li.variantId) await tx.variant.update({ where: { id: li.variantId }, data: { stock: { increment: li.quantity } } });
        else              await tx.product.update({ where: { id: li.productId }, data: { stock: { increment: li.quantity } } });
        await tx.inventoryLog.create({ data: { productId: li.productId, variantId: li.variantId, delta: li.quantity, reason: 'REFUND', refId: order.id, performedBy: adminId } });
      }
    }
    const credited = await tx.loyaltyLedger.findFirst({ where: { userId: order.userId, reason: 'ORDER_CREDIT', refId: order.id } });
    if (credited && credited.delta > 0) await adjustLoyalty(tx, order.userId, -credited.delta, 'ORDER_CREDIT_REVERSE', order.id);
    const redeem = await tx.loyaltyLedger.findFirst({ where: { userId: order.userId, reason: 'REDEEM', refId: order.id } });
    if (redeem && redeem.delta < 0) await adjustLoyalty(tx, order.userId, -redeem.delta, 'REDEEM_REVERSE', order.id);
    await tx.loyaltyLedger.deleteMany({ where: { userId: order.userId, reason: 'ORDER_PENDING', refId: order.id } });
    return { ok: true as const };
  }, TX_OPTS);
}
