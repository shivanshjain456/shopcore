/**
 * /api/compare — Item 14.
 *
 * Three verbs:
 *   GET    — list the current user's compare list (full product data).
 *   POST   — add a product (body: { productId }).
 *   DELETE — clear the entire list.
 *
 * Anonymous and authenticated users share this endpoint — the service
 * module (`lib/account/compare.ts`) dispatches to the cookie or DB
 * backend based on session presence.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { getCurrentUser } from '@/lib/auth/session';
import { requireCompareEnabled } from '@/lib/storeConfig/featureGate';
import {
  addCompare, clearCompare, listCompare, getMaxItems,
} from '@/lib/account/compare';
import { fetchCompareProducts } from '@/lib/compare/compareData';

export const dynamic = 'force-dynamic';

// ── GET ──────────────────────────────────────────────────────────────────

export const GET = withErrorHandling(async () => {
  await requireCompareEnabled();
  const user = await getCurrentUser();
  const entries = await listCompare(user?.id ?? null);
  const ids = entries.map((e) => e.productId);
  const products = await fetchCompareProducts(ids);
  const maxItems = await getMaxItems();
  return jsonOk({
    items: products.map((p, i) => ({
      product: p,
      addedAt: entries[i]?.addedAt.toISOString() ?? new Date().toISOString(),
    })),
    maxItems,
  });
});

// ── POST ─────────────────────────────────────────────────────────────────

const PostBody = z.object({
  productId: z.string().min(1).max(64),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireCompareEnabled();
  const user = await getCurrentUser();
  await applyRateLimit('compare.add', req, { userId: user?.id });

  const { productId } = PostBody.parse(await req.json());
  const entries = await addCompare(user?.id ?? null, productId);
  const maxItems = await getMaxItems();
  return jsonOk({
    items: entries.map((e) => ({ productId: e.productId, addedAt: e.addedAt.toISOString() })),
    maxItems,
  });
});

// ── DELETE (clear all) ──────────────────────────────────────────────────

export const DELETE = withErrorHandling(async () => {
  assertCsrf();
  await requireCompareEnabled();
  const user = await getCurrentUser();
  await clearCompare(user?.id ?? null);
  return jsonOk({ items: [] });
});
