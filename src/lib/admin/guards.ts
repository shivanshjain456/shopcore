/**
 * Common helpers for admin API routes:
 *  - requireAdminUser(): returns the admin user or throws 401/403 JSON Response.
 *  - audit(): writes an AuditLog row tagged with the admin actor.
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { clientIp } from '@/lib/security/ip';
import type { User } from '@prisma/client';
// Pure state-machine helper — imported from the helpers module to avoid
// any chance of cycling through `accountStateMachine.ts`.
import { isLoginPermitted } from '@/lib/auth/accountStateHelpers';

export class AdminGuardError {
  constructor(public response: NextResponse) {}
}

export async function requireAdminUser(): Promise<User> {
  const user = await getCurrentUser({ requireAdmin: true });
  // `getCurrentUser` already returns null for non-login-permitted users
  // (it calls `isLoginPermitted` under the hood) — but we re-check here
  // as defence-in-depth in case `getCurrentUser`'s contract ever changes.
  // The role check is the actual admin gate.
  if (!user || user.role !== 'ADMIN' || !isLoginPermitted(user.status)) {
    throw new AdminGuardError(
      NextResponse.json({ ok: false, error: 'Admin only.' }, { status: 401 }),
    );
  }
  return user;
}

export async function audit(params: {
  actorId: string; action: string; entity: string; entityId?: string | null;
  before?: unknown; after?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      before: params.before !== undefined ? JSON.stringify(params.before) : null,
      after:  params.after  !== undefined ? JSON.stringify(params.after)  : null,
      ipAddress: clientIp(),
    },
  });
}
