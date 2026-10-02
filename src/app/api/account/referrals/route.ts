import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/checkout/storeConfig';
import { env } from '@/lib/config';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const cfg = await getStoreConfig();
  // PAGINATION-EXEMPT: scoped to a single user (referredById === user.id) — bounded.
  const referrals = await prisma.user.findMany({
    where: { referredById: user.id },
    select: { id: true, firstName: true, lastName: true, createdAt: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
  const link = `${env.APP_URL}/signup?ref=${encodeURIComponent(user.referralCode)}`;
  return jsonOk({
    referralCode: user.referralCode,
    referralLink: link,
    referrerBonus: cfg.loyalty.referrerBonus,
    refereeBonus:  cfg.loyalty.refereeBonus,
    referrals: referrals.map((r) => ({
      id: r.id, name: `${r.firstName} ${r.lastName[0]}.`, status: r.status, joinedAt: r.createdAt,
    })),
    totalSignups: referrals.length,
    activeSignups: referrals.filter((r) => r.status === 'ACTIVE').length,
  });
});
