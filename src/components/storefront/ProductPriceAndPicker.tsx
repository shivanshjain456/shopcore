'use client';
/**
 * Owns the variant selection state for the PDP.
 *
 * Renders:
 *   - the headline price block (live, updates instantly on variant change)
 *   - the variant picker buttons
 *   - the in-stock indicator
 *   - the Add-to-Cart button (passes the live selectedVariantId)
 *
 * Why this exists: the previous PDP rendered the headline price on the server
 * with only the product-level fallback, so switching variants in the client
 * picker never updated the displayed price. That created a real
 * financial / trust risk (display price ≠ price sent at Add-to-Cart in some
 * edge cases — and a confusing UX even when the server-side cart eventually
 * computed the right price). This component re-renders the headline price
 * from the SAME pure `selectVariantPrice()` selector that the server uses
 * on first paint, so the two cannot diverge.
 */
import { useMemo, useState } from 'react';
import AddToCartButton from './AddToCartButton';
import BuyNowButton from './BuyNowButton';
import { rupees } from '@/lib/catalog/pricing';
import {
  selectVariantPrice,
  discountPercentForResult,
  type PriceableVariant,
} from '@/lib/catalog/variantPrice';

export interface ClientVariant extends PriceableVariant {
  id: string;
  name: string;
  attributes?: string;
  pricePaise: number;
  mrpPaise: number;
  stock: number;
}

export interface ProductHeader {
  id: string;
  pricePaise: number;        // server-computed effective base price (role-aware)
  mrpPaise: number;
  stock: number;
  gstRate: number;
  isB2B: boolean;
}

export default function ProductPriceAndPicker({
  product, variants, initialSelectedId,
}: {
  product: ProductHeader;
  variants: ClientVariant[];
  initialSelectedId: string | null;
}) {
  const hasVariants = variants.length > 0;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);

  // Live price — re-computed from the SAME pure selector the server used
  const view = useMemo(
    () => selectVariantPrice(
      { id: product.id, pricePaise: product.pricePaise, mrpPaise: product.mrpPaise, stock: product.stock, variants },
      selectedId,
    ),
    [product.id, product.pricePaise, product.mrpPaise, product.stock, variants, selectedId],
  );

  const off = discountPercentForResult(view);

  return (
    <>
      {/* Headline price block — re-renders on every variant change */}
      <div className="mt-4 flex items-baseline gap-3" data-testid="pdp-price-block">
        <span className="text-3xl font-bold text-slate-900" data-testid="pdp-price">
          {rupees(view.pricePaise)}
        </span>
        {view.mrpPaise > view.pricePaise && (
          <>
            <span className="text-slate-400 line-through" data-testid="pdp-mrp">
              {rupees(view.mrpPaise)}
            </span>
            <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-xs font-bold text-white">
              {off}% OFF
            </span>
          </>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Inclusive of all taxes ({product.gstRate}% GST){product.isB2B ? ' · B2B price applied' : ''}
        {view.variantName ? ` · Variant: ${view.variantName}` : ''}
        {view.reason === 'missing-price' && <span className="ml-1 text-red-600">(price unavailable for this variant; showing base price)</span>}
      </p>

      {/* Variant picker */}
      {hasVariants && (
        <div className="mt-5">
          <p className="text-sm font-semibold text-slate-900">Choose variant</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {variants.map((v) => {
              const isSel = v.id === view.selectedVariantId;
              const isOut = (v.stock ?? 0) <= 0 || v.isActive === false;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => !isOut && setSelectedId(v.id)}
                  disabled={isOut}
                  data-testid={`variant-${v.id}`}
                  data-selected={isSel ? 'true' : 'false'}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                    isSel
                      ? 'border-brand-600 bg-brand-50 text-brand-900'
                      : isOut
                        ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 line-through'
                        : 'border-slate-300 bg-white hover:border-brand-300'
                  }`}
                  title={isOut ? 'Out of stock' : v.name}
                >
                  <div className="font-medium">{v.name}</div>
                  <div className="text-xs text-slate-500">
                    {rupees(v.pricePaise)}{isOut ? ' · OOS' : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stock indicator */}
      <p
        className={`mt-3 text-sm ${view.inStock ? 'text-emerald-700' : 'font-semibold text-red-600'}`}
        data-testid="pdp-stock"
      >
        {!view.inStock
          ? 'Out of stock'
          : view.stock <= 5
            ? `Only ${view.stock} left in stock`
            : 'In stock'}
      </p>

      {/* Add-to-cart + Buy Now — variantId tracks live selection (and stays
          null when no variants). Buy Now triggers an express checkout via
          POST /api/checkout/express which upserts a per-user session row
          (NEVER touches the cart) and redirects to /checkout?express=1. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <AddToCartButton
          productId={product.id}
          variantId={hasVariants ? view.selectedVariantId : null}
          disabled={!view.inStock}
          size="lg"
          label={!view.inStock ? 'Out of stock' : 'Add to cart'}
        />
        <BuyNowButton
          productId={product.id}
          variantId={hasVariants ? view.selectedVariantId : null}
          disabled={!view.inStock}
          size="lg"
          label={!view.inStock ? 'Out of stock' : 'Buy now'}
        />
      </div>
    </>
  );
}
