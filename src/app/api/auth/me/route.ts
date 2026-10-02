/** GET /api/auth/me — returns the current user summary or 401. */
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Not authenticated.', 401);
  const tier = user.b2bTierId ? await prisma.b2BTier.findUnique({ where: { id: user.b2bTierId } }) : null;
  return jsonOk({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      city: user.city,
      state: user.state,
      pinCode: user.pinCode,
      country: user.country,
      loyaltyPoints: user.loyaltyPoints,
      referralCode: user.referralCode,
      companyName: user.companyName,
      gstin: user.gstin,
      b2bApprovedAt: user.b2bApprovedAt,
      b2bTier: tier ? { id: tier.id, name: tier.name, discountPercent: tier.discountPercent } : null,
    },
  });
});
