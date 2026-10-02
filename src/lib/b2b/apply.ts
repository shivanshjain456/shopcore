/**
 * B2B application flow.
 *
 * Storage model:
 *  - We use the existing User columns (companyName, gstin, pan) to capture the
 *    application data; B2B status is gated by `b2bApprovedAt` + role==='B2B'.
 *  - "Pending" = companyName+gstin+pan set, role still CUSTOMER, b2bApprovedAt null.
 *  - "Approved" = role flipped to B2B, b2bApprovedAt set, b2bTierId assigned.
 *  - "Rejected" = we clear the company/gstin/pan and write a UserActivity row;
 *    user can re-apply.
 *
 * Admin actions (approve/reject) live in admin routes (Phase 6.2).
 */
import { prisma } from '@/lib/db/client';
import { isValidGstin, isValidPan, normaliseGstin, normalisePan } from './gstin';
import { getStoreConfig } from '@/lib/checkout/storeConfig';

export type ApplyInput = {
  userId: string;
  companyName: string;
  gstin: string;
  pan: string;
};

export type ApplyResult =
  | { ok: true; status: 'PENDING' | 'AUTO_APPROVED' }
  | { ok: false; reason: string };

export async function applyForB2B(input: ApplyInput): Promise<ApplyResult> {
  const cfg = await getStoreConfig();
  const company = input.companyName.trim();
  const gstin   = normaliseGstin(input.gstin);
  const pan     = normalisePan(input.pan);

  if (company.length < 2 || company.length > 200) {
    return { ok: false, reason: 'Company name must be 2–200 characters.' };
  }
  if (cfg.b2b.requireGstin && !isValidGstin(gstin)) {
    return { ok: false, reason: 'Enter a valid 15-character GSTIN.' };
  }
  if (cfg.b2b.requirePan && !isValidPan(pan)) {
    return { ok: false, reason: 'Enter a valid 10-character PAN.' };
  }

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) return { ok: false, reason: 'User not found.' };
  if (user.role === 'B2B' && user.b2bApprovedAt) {
    return { ok: false, reason: 'You are already an approved B2B account.' };
  }
  if (user.role === 'ADMIN') return { ok: false, reason: 'Admins cannot apply for B2B.' };

  // Check for GSTIN already used by another user
  const dup = await prisma.user.findFirst({
    where: { gstin, id: { not: user.id } },
    select: { id: true },
  });
  if (dup) return { ok: false, reason: 'This GSTIN is already on file with another account.' };

  // Capture application data on the user record
  await prisma.user.update({
    where: { id: user.id },
    data: {
      companyName: company, gstin, pan,
      // explicitly keep b2bApprovedAt/role unchanged until admin acts (or auto-approve)
    },
  });
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'B2B_APPLIED', metadata: JSON.stringify({ company, gstin: gstin.slice(0, 2) + '••••' + gstin.slice(-2) }) },
  });

  // Auto-approve if configured
  if (cfg.b2b.autoApprove) {
    const tier = await prisma.b2BTier.findFirst({ where: { isActive: true }, orderBy: { discountPercent: 'asc' } });
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'B2B', b2bApprovedAt: new Date(), b2bTierId: tier?.id ?? null },
    });
    await prisma.userActivity.create({
      data: { userId: user.id, action: 'B2B_AUTO_APPROVED', metadata: JSON.stringify({ tierId: tier?.id ?? null }) },
    });
    return { ok: true, status: 'AUTO_APPROVED' };
  }

  return { ok: true, status: 'PENDING' };
}

/** Read application + B2B state for the current user. */
export async function getB2BProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { b2bTier: true },
  });
  if (!user) return null;
  const isPending = !!user.companyName && !!user.gstin && user.role !== 'B2B' && !user.b2bApprovedAt;
  return {
    role: user.role,
    status: user.role === 'B2B' && user.b2bApprovedAt ? 'APPROVED'
          : isPending ? 'PENDING'
          : 'NONE',
    companyName: user.companyName,
    gstin: user.gstin,
    pan: user.pan,
    approvedAt: user.b2bApprovedAt,
    tier: user.b2bTier ? {
      id: user.b2bTier.id, name: user.b2bTier.name,
      discountPercent: user.b2bTier.discountPercent,
      minOrderPaise: user.b2bTier.minOrderPaise,
    } : null,
  };
}
