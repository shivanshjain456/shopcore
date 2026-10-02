import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { prisma } from '@/lib/db/client';
import { adjustLoyalty } from '@/lib/account/loyalty';
import { disableUserInFirebase } from '@/lib/auth/firebase';
import {
  transitionAccountState, UserStatus,
  type TransitionFailureReason,
} from '@/lib/auth/accountStateMachine';

/** Map state-machine failures to HTTP responses the admin UI can show. */
function stateMachineErrorStatus(reason: TransitionFailureReason): number {
  switch (reason) {
    case 'USER_NOT_FOUND':           return 404;
    case 'ILLEGAL_TRANSITION':       return 409;
    case 'ACTOR_NOT_PERMITTED':      return 403;
    case 'PRECONDITION_FAILED':      return 400;
    case 'CONCURRENT_MODIFICATION':  return 409;
  }
}

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
  loyaltyAdjust: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  loyaltyAdjustReason: z.string().trim().max(200).optional(),
});

export const GET = withErrorHandling(async (_: Request, { params }: { params: { id: string } }) => {
  await requireAdminUser();
  const u = await prisma.user.findUnique({
    where: { id: params.id },
    include: {
      b2bTier: true, addresses: true,
      orders: { orderBy: { createdAt: 'desc' }, take: 10 },
      loyaltyLedger: { orderBy: { createdAt: 'desc' }, take: 20 },
      _count: { select: { orders: true, reviews: true, returns: true, tickets: true } },
    },
  });
  if (!u) return jsonError('Not found.', 404);
  return jsonOk({ user: u });
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const admin = await requireAdminUser();
  const body = PatchBody.parse(await req.json());
  const existing = await prisma.user.findUnique({ where: { id: params.id } });
  if (!existing) return jsonError('Not found.', 404);
  if (existing.role === 'ADMIN' && body.status === 'SUSPENDED') return jsonError('Cannot suspend an admin.', 400);

  // Route all status changes through the Account State Machine.
  // The machine validates the transition, runs preconditions, writes
  // the AuditLog + UserActivity rows, and revokes refresh families for
  // SUSPEND / DELETE — every concern that was previously inline here.
  let updated = existing;
  if (body.status) {
    // Skip no-op (the machine would reject it as ILLEGAL_TRANSITION,
    // but it's a more natural "200 with no change" from the admin UI).
    if (body.status !== existing.status) {
      const r = await transitionAccountState(
        existing.id,
        body.status,
        { type: 'ADMIN', adminId: admin.id },
        { reason: 'Admin customer-detail action' },
      );
      if (!r.ok) {
        return jsonError(
          r.detail ?? `Cannot transition ${existing.status} → ${body.status}.`,
          stateMachineErrorStatus(r.reason),
          { code: r.reason, from: r.from, to: r.to },
        );
      }
      updated = r.user;
      // Firebase mirror — independent of the state machine because the
      // mirror is an external integration, not an account-status concern.
      if ((body.status === UserStatus.SUSPENDED || body.status === UserStatus.DELETED)
          && existing.firebaseUid) {
        await disableUserInFirebase(existing.firebaseUid);
      }
    }
  }

  if (typeof body.loyaltyAdjust === 'number' && body.loyaltyAdjust !== 0) {
    await prisma.$transaction(async (tx) => {
      await adjustLoyalty(tx, existing.id, body.loyaltyAdjust!, 'ADMIN_ADJUST');
    });
  }

  // The state machine already wrote a granular AuditLog row for the
  // status change; this CUSTOMER_UPDATE row captures any non-status
  // edits in the same request (today: only loyaltyAdjust, but the
  // shape is forward-compatible).
  if ((typeof body.loyaltyAdjust === 'number' && body.loyaltyAdjust !== 0) && !body.status) {
    await audit({ actorId: admin.id, action: 'CUSTOMER_UPDATE', entity: 'User', entityId: existing.id, before: existing, after: updated });
  }
  return jsonOk({ user: updated });
});
