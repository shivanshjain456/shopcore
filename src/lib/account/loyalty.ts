/**
 * Loyalty ledger helpers.
 *
 * `User.loyaltyPoints` is the canonical balance; LoyaltyLedger is the audit trail.
 * Every credit/debit MUST go through these helpers so the two stay in sync.
 *
 * Reasons:
 *   ORDER_PENDING        — placed at order time (delta 0; admin payment-verify will credit)
 *   ORDER_CREDIT         — admin payment-verified; positive delta
 *   ORDER_CREDIT_REVERSE — on cancel/refund after credit
 *   REDEEM               — used at checkout; negative delta
 *   REDEEM_REVERSE       — on cancel
 *   REFERRAL_REFERRER    — when referee signs up & makes first verified order
 *   REFERRAL_REFEREE     — same trigger, given to referee
 *   SIGNUP_BONUS         — on email verification
 *   ADMIN_ADJUST         — manual admin tweak
 *   REVIEW_REWARD        — when admin approves first review (optional)
 */
import type { Prisma } from '@prisma/client';

export async function adjustLoyalty(
  tx: Prisma.TransactionClient,
  userId: string, delta: number, reason: string, refId?: string,
): Promise<{ newBalance: number }> {
  if (delta === 0) {
    await tx.loyaltyLedger.create({ data: { userId, delta: 0, reason, refId } });
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { loyaltyPoints: true } });
    return { newBalance: u.loyaltyPoints };
  }
  await tx.loyaltyLedger.create({ data: { userId, delta, reason, refId } });
  const u = await tx.user.update({
    where: { id: userId },
    data: { loyaltyPoints: { increment: delta } },
    select: { loyaltyPoints: true },
  });
  return { newBalance: u.loyaltyPoints };
}

export interface LoyaltyView {
  balance: number;
  signupBonus: number;
  earnRate: number;
  redeemValuePaise: number;
  ledger: Array<{ id: string; delta: number; reason: string; refId: string | null; createdAt: string }>;
}
