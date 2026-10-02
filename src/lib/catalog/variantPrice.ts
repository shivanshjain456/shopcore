/**
 * Variant price selector — SINGLE SOURCE OF TRUTH for "what price should the
 * PDP show for the currently-chosen variant?"
 *
 * Used by BOTH:
 *   - server-side initial render in `(storefront)/p/[slug]/page.tsx`
 *   - client-side reactive update in `ProductPriceAndPicker.tsx`
 *
 * That guarantees the headline price seen at first paint cannot diverge from
 * the price shown after a variant switch — the same pure function produces
 * both.
 *
 * Defensive on every input shape we've actually seen in the wild:
 *   - product with NO variants array            → fall back to product price
 *   - product with EMPTY variants array         → fall back to product price
 *   - selectedId references a missing variant   → fall back to first variant
 *                                                  (or product price if none),
 *                                                  flagged via `reason`
 *   - variant with undefined / null pricePaise  → fall back to product price,
 *                                                  flagged via `reason`
 *   - float-shaped pricePaise (legacy data)     → coerced to integer paise
 *
 * The function is PURE: no React, no DOM, no DB. Easy to unit-test exhaustively.
 */

export interface PriceableVariant {
  id: string;
  name: string;
  pricePaise?: number | null;
  mrpPaise?: number | null;
  stock?: number | null;
  isActive?: boolean;
}

export interface PriceableProduct {
  id: string;
  pricePaise: number;
  mrpPaise: number;
  stock?: number | null;
  variants?: PriceableVariant[] | null;
}

export type VariantPriceReason =
  | 'no-variants'          // product has no variants array (or empty)
  | 'selected-found'       // selectedId matched an active variant
  | 'selected-not-found'   // selectedId given but no match — fell back
  | 'fallback-first'       // no selectedId given — used first variant
  | 'missing-price'        // matched variant had no usable pricePaise
  | 'all-inactive';        // every variant inactive — used product price

export interface VariantPriceResult {
  pricePaise: number;          // ALWAYS an integer paise value, ≥ 0
  mrpPaise: number;            // ALWAYS an integer paise value, ≥ pricePaise
  selectedVariantId: string | null;
  variantName: string | null;
  stock: number;               // ≥ 0
  inStock: boolean;
  isActive: boolean;
  reason: VariantPriceReason;
}

/** Force-coerce a numeric-ish input to a non-negative integer paise. */
function toPaise(n: unknown): number {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
    // legacy rows might have come in as 999.5 — round to nearest paise
    return Math.round(n);
  }
  if (typeof n === 'string') {
    const x = Number(n);
    if (Number.isFinite(x) && x >= 0) return Math.round(x);
  }
  return 0;
}

/**
 * Compute the price to display for a given product + selected variant.
 *
 * @param product       The product row (or a shape with at least `pricePaise`,
 *                      `mrpPaise`, optional `variants`).
 * @param selectedId    The variant id the user has chosen — pass `null` on
 *                      first paint to get the default.
 *
 * Returns a fully-resolved `{ pricePaise, mrpPaise, … reason }` object;
 * never throws.
 */
export function selectVariantPrice(
  product: PriceableProduct,
  selectedId: string | null | undefined,
): VariantPriceResult {
  // Robust against null / non-array `variants`
  const variants: PriceableVariant[] = Array.isArray(product.variants) ? product.variants : [];

  // Path 1 — no variants at all
  if (variants.length === 0) {
    const price = toPaise(product.pricePaise);
    const mrp   = Math.max(toPaise(product.mrpPaise), price);
    const stock = Math.max(0, Number(product.stock ?? 0) | 0);
    return {
      pricePaise: price, mrpPaise: mrp,
      selectedVariantId: null, variantName: null,
      stock, inStock: stock > 0,
      isActive: true,
      reason: 'no-variants',
    };
  }

  // Path 2 — try to match the requested selectedId
  const active = variants.filter((v) => v.isActive !== false); // treat undefined as active
  if (active.length === 0) {
    // Every variant inactive — fall back to product-level price; we still
    // want the user to see SOMETHING rather than a blank.
    const price = toPaise(product.pricePaise);
    const mrp   = Math.max(toPaise(product.mrpPaise), price);
    return {
      pricePaise: price, mrpPaise: mrp,
      selectedVariantId: null, variantName: null,
      stock: 0, inStock: false, isActive: false,
      reason: 'all-inactive',
    };
  }

  let chosen: PriceableVariant;
  let reason: VariantPriceReason;

  if (selectedId) {
    const hit = active.find((v) => v.id === selectedId);
    if (hit) { chosen = hit; reason = 'selected-found'; }
    else     { chosen = active[0]; reason = 'selected-not-found'; }
  } else {
    chosen = active[0]; reason = 'fallback-first';
  }

  // Path 3 — variant matched but its pricePaise is missing/garbage
  const vPrice = toPaise(chosen.pricePaise);
  let pricePaise: number;
  if (vPrice <= 0 && chosen.pricePaise == null) {
    // Use product-level as a safety net; mark reason so UI can warn
    pricePaise = toPaise(product.pricePaise);
    reason = 'missing-price';
  } else {
    pricePaise = vPrice;
  }

  const mrpFromVariant = toPaise(chosen.mrpPaise);
  const mrpPaise = Math.max(mrpFromVariant || toPaise(product.mrpPaise), pricePaise);
  const stock = Math.max(0, Number(chosen.stock ?? 0) | 0);

  return {
    pricePaise,
    mrpPaise,
    selectedVariantId: chosen.id,
    variantName: chosen.name,
    stock,
    inStock: stock > 0,
    isActive: chosen.isActive !== false,
    reason,
  };
}

/** Convenience: format for display. */
export function discountPercentForResult(r: VariantPriceResult): number {
  if (r.mrpPaise <= 0 || r.pricePaise >= r.mrpPaise) return 0;
  return Math.round(((r.mrpPaise - r.pricePaise) / r.mrpPaise) * 100);
}
