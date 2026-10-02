'use client';
/**
 * <CompareProductHeader> — Item 14.
 *
 * The top cell of each product column on /compare:
 *   - Remove (×) button (top-right; calls back into the parent).
 *   - Product image (≥ 200 px square on desktop).
 *   - Linked product title.
 *   - Brand name.
 *   - Star rating + review count.
 *   - Stock badge.
 *
 * Visual style intentionally matches `<ProductCard>` so the compare
 * view feels like a natural extension of catalogue browsing.
 */
import Link from 'next/link';
import type { CompareProduct } from '@/lib/compare/compareData';

interface Props {
  product:  CompareProduct;
  onRemove: () => void;
}

function StockBadge({ status }: { status: CompareProduct['display']['stockStatus'] }) {
  const cls =
    status === 'IN_STOCK'    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
  : status === 'LOW_STOCK'   ? 'bg-amber-50   text-amber-800   border-amber-200'
  :                            'bg-red-50     text-red-800     border-red-200';
  const text =
    status === 'IN_STOCK'    ? 'In stock'
  : status === 'LOW_STOCK'   ? 'Low stock'
  :                            'Out of stock';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {text}
    </span>
  );
}

function Stars({ value }: { value: number }) {
  const rounded = Math.round(value);
  return (
    <span aria-label={`${value.toFixed(1)} out of 5 stars`} className="text-amber-500" role="img">
      {'★'.repeat(rounded)}<span className="text-slate-300">{'★'.repeat(5 - rounded)}</span>
    </span>
  );
}

export default function CompareProductHeader({ product, onRemove }: Props) {
  return (
    <div className="relative flex h-full flex-col gap-2 p-3">
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${product.name} from compare`}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border border-slate-300 bg-white text-xs font-bold text-slate-600 hover:bg-slate-50"
      >
        ×
      </button>

      <Link href={`/p/${product.slug}`} className="block">
        <div className="aspect-square w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full place-items-center text-xs text-slate-400">No image</div>
          )}
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-semibold text-slate-900 hover:text-brand-700">
          {product.name}
        </p>
      </Link>

      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600">{product.brand?.name ?? '—'}</span>
        <StockBadge status={product.display.stockStatus} />
      </div>

      <div className="flex items-center gap-1 text-xs text-slate-600">
        {product.reviews.count > 0 ? (
          <>
            <Stars value={product.reviews.averageRating} />
            <span className="tabular-nums">{product.reviews.averageRating.toFixed(1)}</span>
            <span>({product.reviews.count})</span>
          </>
        ) : (
          <span className="italic text-slate-400">No reviews yet</span>
        )}
      </div>
    </div>
  );
}
