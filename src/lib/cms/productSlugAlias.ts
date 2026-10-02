/**
 * Product slug-alias service — Feature #35.
 *
 *   When a product's slug changes (e.g. admin renames the product), any
 *   URL a customer already shared (WhatsApp, Twitter, email) would 404
 *   without an alias table. We record the old slug here on rename and
 *   the PDP looks up by current slug first, then by alias.
 *
 *   API:
 *     - `findProductIdBySlug(slug)`            → look up by current slug
 *                                                 OR alias. Returns
 *                                                 `{ productId, isAlias }`
 *                                                 or null.
 *     - `recordSlugChange(productId, oldSlug)` → writes an alias row for
 *                                                 the old slug, idempotent.
 *     - `removeAlias(slug)`                    → for tests / admin tooling.
 *
 *   The current Product.slug column is the source of truth — aliases
 *   are a redirect-only convenience, never a primary identifier.
 */
import { prisma } from '@/lib/db/client';

export async function findProductIdBySlug(slug: string): Promise<{
  productId: string; isAlias: boolean; currentSlug: string;
} | null> {
  const trimmed = (slug ?? '').trim();
  if (!trimmed) return null;

  // 1. Look up by current Product.slug — the happy path.
  const current = await prisma.product.findUnique({
    where: { slug: trimmed },
    select: { id: true, slug: true },
  });
  if (current) {
    return { productId: current.id, isAlias: false, currentSlug: current.slug };
  }

  // 2. Look up by alias.
  const alias = await prisma.productSlugAlias.findUnique({
    where: { slug: trimmed },
    select: { productId: true, product: { select: { slug: true } } },
  });
  if (alias && alias.product) {
    return { productId: alias.productId, isAlias: true, currentSlug: alias.product.slug };
  }

  return null;
}

/**
 * Record an alias mapping the OLD slug → the current product. Idempotent
 * (upserts on the unique `slug` constraint). Refuses to write an alias
 * for a slug that's already owned by a different product.
 */
export async function recordSlugChange(productId: string, oldSlug: string): Promise<void> {
  const slug = (oldSlug ?? '').trim();
  if (!slug || !productId) return;

  // Guard: another product already owns this slug? Refuse silently — the
  // caller's data is inconsistent and we don't want to point a shared URL
  // at the wrong product.
  const collision = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
  if (collision && collision.id !== productId) return;

  // Upsert so re-naming back and forth is idempotent.
  await prisma.productSlugAlias.upsert({
    where:  { slug },
    create: { slug, productId },
    update: { productId },
  });
}

export async function removeAlias(slug: string): Promise<void> {
  const trimmed = (slug ?? '').trim();
  if (!trimmed) return;
  await prisma.productSlugAlias.deleteMany({ where: { slug: trimmed } });
}
