/**
 * Reviews are gated to users who actually purchased + received the product.
 *
 * Approval flow: every review starts with isApproved=false; admin moderates in Phase 7.
 * (Public PDP only shows isApproved=true reviews.)
 */
import { prisma } from '@/lib/db/client';

export async function reviewableProductsForUser(userId: string) {
  // Products in DELIVERED orders that user hasn't reviewed yet.
  const delivered = await prisma.orderItem.findMany({
    where: { order: { userId, status: 'DELIVERED' } },
    distinct: ['productId'],
    include: { product: { select: { id: true, slug: true, name: true, images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } } } },
  });
  const reviewed = await prisma.review.findMany({ where: { userId }, select: { productId: true } });
  const reviewedSet = new Set(reviewed.map((r) => r.productId));
  return delivered.filter((d) => !reviewedSet.has(d.productId)).map((d) => d.product);
}

export interface CreateReviewInput {
  userId: string;
  productId: string;
  rating: number;
  title?: string | null;
  body?: string | null;
  imageUrls?: string[];
}

export async function createReview(input: CreateReviewInput): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (input.rating < 1 || input.rating > 5) return { ok: false, reason: 'Rating must be 1–5.' };

  // Verify purchase
  const delivered = await prisma.orderItem.findFirst({
    where: { productId: input.productId, order: { userId: input.userId, status: 'DELIVERED' } },
  });
  if (!delivered) return { ok: false, reason: 'You can review a product only after it is delivered.' };

  // One review per (user, product)
  const existing = await prisma.review.findUnique({
    where: { productId_userId: { productId: input.productId, userId: input.userId } },
  });
  if (existing) return { ok: false, reason: 'You have already reviewed this product.' };

  const r = await prisma.review.create({
    data: {
      productId: input.productId, userId: input.userId,
      rating: input.rating, title: input.title ?? null, body: input.body ?? null,
      imagesJson: input.imageUrls && input.imageUrls.length ? JSON.stringify(input.imageUrls) : null,
      isApproved: false,
    },
  });
  await prisma.userActivity.create({
    data: { userId: input.userId, action: 'REVIEW_SUBMITTED', metadata: JSON.stringify({ reviewId: r.id, productId: input.productId }) },
  });
  return { ok: true, id: r.id };
}
