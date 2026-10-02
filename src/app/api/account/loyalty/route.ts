import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { toLoyaltyConfig } from '@/lib/account/loyaltyFormula';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const cfg = await getStoreConfig();
  const loy = toLoyaltyConfig(cfg.loyalty as unknown as Record<string, unknown>);
  const ledger = await prisma.loyaltyLedger.findMany({
    where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 100,
  });

  // Build a customer-facing description from the active formula
  let description = 'Loyalty is currently disabled.';
  if (loy.enabled && loy.mode === 'PER_AMOUNT' && loy.pointsPerAmount > 0) {
    description = `Earn ${loy.pointsPerAmount} point${loy.pointsPerAmount === 1 ? '' : 's'} for every ₹${loy.amountUnitPaise / 100} spent (after discounts).`;
  } else if (loy.enabled && loy.mode === 'PERCENT' && loy.percentBps > 0) {
    description = `Earn ${loy.percentBps / 100}% of your order value (after discounts) back as points.`;
  }

  return jsonOk({
    balance: user.loyaltyPoints,
    enabled: loy.enabled,
    mode: loy.mode,
    description,
    pointsPerAmount: loy.pointsPerAmount,
    amountUnitPaise: loy.amountUnitPaise,
    percentBps: loy.percentBps,
    redeemValuePaise: loy.redeemValuePaise,
    signupBonus: loy.signupBonus,
    ledger: ledger.map((l) => ({
      id: l.id, delta: l.delta, reason: l.reason, refId: l.refId, createdAt: l.createdAt,
    })),
  });
});
