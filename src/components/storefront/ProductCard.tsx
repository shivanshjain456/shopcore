'use client';

import Link from 'next/link';
import { discountPercent, rupees } from '@/lib/catalog/pricing';
import WishlistButton from './WishlistButton';
import CompareButton from './CompareButton';

export interface ProductCardData {
  id: string;
  slug: string;
  name: string;
  shortDesc?: string | null;
  mrpPaise: number;
  pricePaise: number;
  imageUrl: string | null;
  brand?: { name: string } | null;
  category?: { name: string; slug: string } | null;
  hasVariants?: boolean;
  stock?: number;
}

export default function ProductCard({ p }: { p: ProductCardData }) {
  const off = discountPercent(p.mrpPaise, p.pricePaise);
  const outOfStock = (p.stock ?? 1) <= 0 && !p.hasVariants;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-brand-300 hover:shadow-md">
      <Link href={`/p/${p.slug}`} className="block aspect-[3/2] overflow-hidden bg-slate-50">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-300">No image</div>
        )}
      </Link>
      <div className="absolute right-2 top-2">
        <WishlistButton productId={p.id} />
      </div>
      {off > 0 && (
        <span className="absolute left-2 top-2 rounded bg-emerald-600 px-1.5 py-0.5 text-xs font-bold text-white">
          {off}% OFF
        </span>
      )}
      <div className="flex flex-1 flex-col gap-1 p-3">
        {p.brand?.name && <p className="text-xs uppercase tracking-wide text-slate-500">{p.brand.name}</p>}
        <Link href={`/p/${p.slug}`} className="line-clamp-2 text-sm font-semibold text-slate-900 hover:text-brand-700">
          {p.name}
        </Link>
        {p.shortDesc && <p className="line-clamp-2 text-xs text-slate-500">{p.shortDesc}</p>}
        <div className="mt-auto flex items-baseline gap-2 pt-2">
          <span className="text-lg font-bold text-slate-900">{rupees(p.pricePaise)}</span>
          {p.mrpPaise > p.pricePaise && (
            <span className="text-xs text-slate-400 line-through">{rupees(p.mrpPaise)}</span>
          )}
        </div>
        {outOfStock && <p className="text-xs font-semibold text-red-600">Out of stock</p>}
        <div className="pt-2">
          {/* Item 14 — quick add-to-compare from the catalogue grid. */}
          <CompareButton productId={p.id} size="sm" className="w-full justify-center" />
        </div>
      </div>
    </div>
  );
}
