import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { requireWishlistEnabled } from '@/lib/storeConfig/featureGate';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const Body = z.object({ productId: z.string().min(1) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  // Item 8 — feature gate AFTER auth. We deliberately preserve the
  // existing ordering: SUSPENDED / DELETED users get the AUTH-LAYER
  // 401 (the stronger guarantee) before the feature gate's 403 fires.
  // Edge-case D2.3 (state-machine guard) asserted this ordering and
  // we kept it.
  const user = await getCurrentUser();
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  await requireWishlistEnabled();
  const { productId } = Body.parse(await req.json());

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId: user!.id, productId } },
  });
  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    return jsonOk({ added: false });
  }
  await prisma.wishlistItem.create({ data: { userId: user!.id, productId } });
  return jsonOk({ added: true });
});
