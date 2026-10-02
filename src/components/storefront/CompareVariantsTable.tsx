'use client';
/**
 * <CompareVariantsTable> — Item 14.
 *
 * Shows the product's variants in a tiny inline table inside its
 * compare column. Each row = one variant (name + price + stock).
 *
 * Renders a "No variants" placeholder when the product has none, so
 * the row alignment with neighbouring product columns stays clean.
 */
import { rupees } from '@/lib/catalog/pricing';
import type { CompareProduct } from '@/lib/compare/compareData';

interface Props {
  variants: CompareProduct['variants'];
}

export default function CompareVariantsTable({ variants }: Props) {
  if (variants.length === 0) {
    return <p className="text-xs italic text-slate-400">No variants</p>;
  }
  return (
    <table className="w-full text-[11px]">
      <thead className="text-left text-slate-500">
        <tr>
          <th className="py-0.5 pr-2 font-medium">Variant</th>
          <th className="py-0.5 pr-2 text-right font-medium">Price</th>
          <th className="py-0.5 text-right font-medium">Stock</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {variants.map((v) => (
          <tr key={v.id}>
            <td className="py-1 pr-2 text-slate-700">{v.name}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{rupees(v.pricePaise)}</td>
            <td className={`py-1 text-right tabular-nums ${v.stock <= 0 ? 'text-red-600' : 'text-slate-700'}`}>
              {v.stock <= 0 ? 'Out' : v.stock}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
