/**
 * GET /api/admin/b2b-applications — DUAL-LIST endpoint:
 *   `pending`  — recent unreviewed applications (bounded)
 *   `approved` — recent approved B2B accounts (bounded)
 *
 * This is NOT a single-list endpoint, so it does NOT use the standard
 * `{ items, pagination }` envelope from Item 12. It does, however,
 * respect the same `paginationMaxSize` cap to prevent unbounded
 * findMany — both lists are capped at the config max.
 *
 * If the admin needs full pagination over either half, the unified
 * `/api/admin/customers?role=B2B` endpoint serves that use case.
 */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  await requireAdminUser();
  // Item 12 — bound both lists at config max so the endpoint can
  // never become a memory bomb.
  const config = await getStoreConfig();
  const cap = Math.max(1, Math.floor(config.performance.paginationMaxSize ?? 100));

  // Pending: has companyName + gstin, role !== B2B, b2bApprovedAt null
  const pending = await prisma.user.findMany({
    where: { companyName: { not: null }, gstin: { not: null }, role: { not: 'B2B' }, b2bApprovedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: cap,
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, companyName: true, gstin: true, pan: true, createdAt: true, updatedAt: true },
  });
  const approved = await prisma.user.findMany({
    where: { role: 'B2B', b2bApprovedAt: { not: null } },
    orderBy: { b2bApprovedAt: 'desc' },
    take: Math.min(50, cap),
    include: { b2bTier: true },
  });
  return jsonOk({
    pending,
    approved: approved.map((u) => ({
      id: u.id, email: u.email, companyName: u.companyName, gstin: u.gstin,
      tier: u.b2bTier ? { id: u.b2bTier.id, name: u.b2bTier.name, discountPercent: u.b2bTier.discountPercent } : null,
      approvedAt: u.b2bApprovedAt,
    })),
  });
});
