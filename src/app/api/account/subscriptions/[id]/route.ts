import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  isActive:     z.boolean().optional(),
  quantity:     z.number().int().min(1).max(10).optional(),
  intervalDays: z.number().int().min(7).max(180).optional(),
});

async function loadOwn(userId: string, id: string) {
  const s = await prisma.subscription.findUnique({ where: { id } });
  if (!s || s.userId !== userId) return null;
  return s;
}

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const s = await loadOwn(user.id, params.id);
  if (!s) return jsonError('Not found.', 404);
  const data = PatchBody.parse(await req.json());
  // If interval changed, push nextOrderAt to keep cadence reasonable
  const next = data.intervalDays
    ? new Date(Date.now() + data.intervalDays * 86400_000)
    : undefined;
  const upd = await prisma.subscription.update({
    where: { id: s.id },
    data: { ...data, ...(next ? { nextOrderAt: next } : {}) },
  });
  return jsonOk({ subscription: upd });
});

export const DELETE = withErrorHandling(async (_: NextRequest, { params }: { params: { id: string } }) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const s = await loadOwn(user.id, params.id);
  if (!s) return jsonError('Not found.', 404);
  await prisma.subscription.delete({ where: { id: s.id } });
  return jsonOk({ deleted: true });
});
