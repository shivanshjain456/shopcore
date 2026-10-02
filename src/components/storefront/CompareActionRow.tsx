'use client';
/**
 * <CompareActionRow> — Item 14.
 *
 * Bottom row of the compare table. Reuses `<AddToCartButton>`,
 * `<BuyNowButton>`, `<WishlistButton>` without modification — the
 * compare feature is a CONSUMER of these, not an owner.
 *
 * Visual emphasis: a slightly darker background and a top border so
 * this row reads as a distinct call-to-action block.
 */
import AddToCartButton from './AddToCartButton';
import BuyNowButton from './BuyNowButton';
import WishlistButton from './WishlistButton';
import type { CompareProduct } from '@/lib/compare/compareData';

interface Props {
  product: CompareProduct;
}

export default function CompareActionRow({ product }: Props) {
  const outOfStock = product.display.stockStatus === 'OUT_OF_STOCK' && product.variants.length === 0;
  return (
    <div className="flex h-full flex-col items-stretch gap-2 p-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          {product.display.discountPercent > 0 && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
              {product.display.discountPercent}% off
            </span>
          )}
          <span className="text-xl font-extrabold text-slate-900 tabular-nums">
            {product.display.price}
          </span>
          {product.display.discountPercent > 0 && (
            <span className="text-xs text-slate-500 line-through tabular-nums">{product.display.mrp}</span>
          )}
        </div>
        <WishlistButton productId={product.id} />
      </div>
      <BuyNowButton  productId={product.id} disabled={outOfStock} size="md" />
      <AddToCartButton productId={product.id} disabled={outOfStock} size="sm" />
    </div>
  );
}
