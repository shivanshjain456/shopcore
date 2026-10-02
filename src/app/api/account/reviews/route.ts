import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { requireWritePermitted } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { createReview, reviewableProductsForUser } from '@/lib/account/reviews';
import { requireReviewsEnabled } from '@/lib/storeConfig/featureGate';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const which = req.nextUrl.searchParams.get('which') ?? 'mine';
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    req.nextUrl.searchParams, config, { defaultPageSize: 10 },
  );

  // ── `eligible` view: products the user can review (i.e. delivered).
  if (which === 'eligible') {
    const products = await reviewableProductsForUser(user.id);
    // reviewableProductsForUser already bounds — slice for the page.
    const total = products.length;
    const items = products.slice(skip, skip + take).map((p) => ({
      id: p.id, slug: p.slug, name: p.name, imageUrl: p.images[0]?.url ?? null,
    }));
    return jsonOk(buildPagination(items, total, page, pageSize));
  }

  // ── default `mine` view: the user's own reviews.
  const where = { userId: user.id };
  const [total, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: { product: { select: { id: true, slug: true, name: true, images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } } } },
    }),
  ]);
  const items = rows.map((r) => ({
    id: r.id, rating: r.rating, title: r.title, body: r.body, isApproved: r.isApproved,
    createdAt: r.createdAt,
    product: { id: r.product.id, slug: r.product.slug, name: r.product.name, imageUrl: r.product.images[0]?.url ?? null },
  }));
  return jsonOk(buildPagination(items, total, page, pageSize));
});

const Body = z.object({
  productId: z.string().min(1),
  rating:    z.number().int().min(1).max(5),
  title:     z.string().trim().max(120).optional().nullable(),
  body:      z.string().trim().max(2000).optional().nullable(),
  imageUrls: z.array(z.string().startsWith('/api/uploads/')).max(5).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  // Account-state gate: writing reviews requires ACTIVE status. A user
  // in PENDING_PHONE_VERIFICATION / SUSPENDED can still log in (so they
  // can resume verification or read their order history) but must not
  // be able to publish content. Runs BEFORE the feature gate so an
  // unauthenticated caller still gets 401 (not 403 FEATURE_DISABLED) —
  // mirrors the precedent set by edge-case D2.3.
  const guard = requireWritePermitted(user);
  if (guard) return guard;
  // Item 8 — feature gate AFTER auth.
  await requireReviewsEnabled();
  const data = Body.parse(await req.json());
  const r = await createReview({ userId: user!.id, ...data });
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ id: r.id });
});
