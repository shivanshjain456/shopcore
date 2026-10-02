'use client';
/**
 * <CompareTable> — Item 14. Main compare layout.
 *
 *   Left column   = group / attribute labels (the row-axis).
 *   Right columns = compared products (1 to 4).
 *
 * Sections rendered in order:
 *   1. PRODUCT HEADER   (image / title / brand / rating / stock badge)
 *   2. RATINGS BREAKDOWN
 *   3. VARIANTS         (mini-table per product)
 *   4. UNIVERSAL groups (overview / pricing / availability)
 *   5. CATEGORY groups  (depends on product category — display, perf,
 *                        connectivity, physical, ...)
 *   6. OTHER SPECS      (synthetic group catching attributes JSON keys
 *                        not covered above)
 *   7. ACTION ROW       (Add to cart / Buy now / Wishlist / Remove)
 *
 * "Show only differences" toggle hides every attribute row where the
 * detector reports no difference. Sections 1 / 2 / 7 always render.
 */
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { CompareProduct } from '@/lib/compare/compareData';
import {
  getAttributeGroupsForCategories,
  type AttributeGroup,
} from '@/lib/compare/attributeGroups';
import { unionAttributeKeys, leftoverAttributeKeys } from '@/lib/compare/attributeKeyResolver';
import { detectDifference } from '@/lib/compare/differenceDetector';
import CompareProductHeader from './CompareProductHeader';
import CompareActionRow from './CompareActionRow';
import CompareRatingBreakdown from './CompareRatingBreakdown';
import CompareVariantsTable from './CompareVariantsTable';
import CompareAttributeRow from './CompareAttributeRow';

interface Props {
  products:     CompareProduct[];
  initialDiff:  boolean;
  /** Called when a product is removed (parent updates state). */
  onRemove:     (productId: string) => void;
}

/** Read an `intrinsic` group key off a `CompareProduct`. Returns a
 *  display-ready value (string / number / null) for the attribute row. */
function readIntrinsic(p: CompareProduct, key: string): unknown {
  switch (key) {
    case 'brand':            return p.brand?.name ?? null;
    case 'category':         return p.category.name;
    case 'sku':              return p.sku;
    case 'mrp':              return p.display.mrp;
    case 'price':            return p.display.price;
    case 'discount_percent': return p.display.discountPercent > 0 ? `${p.display.discountPercent}%` : null;
    case 'gst_rate':         return `${p.gstRate}%`;
    case 'hsn_code':         return p.hsnCode;
    case 'avg_rating':       return p.reviews.count === 0 ? null : `${p.reviews.averageRating.toFixed(1)} ★`;
    case 'review_count':     return p.reviews.count;
    case 'stock_status':
      return p.display.stockStatus === 'IN_STOCK'  ? 'In stock'
           : p.display.stockStatus === 'LOW_STOCK' ? `Low (${p.stock} left)`
           :                                         'Out of stock';
    default: return null;
  }
}

export default function CompareTable({ products, initialDiff, onRemove }: Props) {
  const router     = useRouter();
  const pathname   = usePathname();
  const searchParams = useSearchParams();
  const [diffOnly, setDiffOnly] = useState<boolean>(initialDiff);

  // URL-sync the diff toggle so the state is shareable.
  function toggleDiff(): void {
    const next = !diffOnly;
    setDiffOnly(next);
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set('diff', '1'); else sp.delete('diff');
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Build the group list. Universal groups + the union of category-
  // specific groups for every compared product's category.
  const groups: AttributeGroup[] = useMemo(
    () => getAttributeGroupsForCategories(products.map((p) => p.category.slug)),
    [products],
  );

  // Build the "Other specs" synthetic group from leftover keys.
  const otherGroup: AttributeGroup | null = useMemo(() => {
    const allKeys     = unionAttributeKeys(products.map((p) => p.attributes));
    const coveredKeys = groups.flatMap((g) => g.kind === 'attributes' ? g.attributes.map((a) => a.key) : []);
    const leftover    = leftoverAttributeKeys(allKeys, coveredKeys);
    if (leftover.length === 0) return null;
    return {
      id:    'other_specs',
      label: 'Other specifications',
      kind:  'attributes',
      attributes: leftover.map((k) => ({
        key:   k,
        label: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    };
  }, [products, groups]);

  const renderedGroups: AttributeGroup[] = useMemo(
    () => otherGroup ? [...groups, otherGroup] : groups,
    [groups, otherGroup],
  );

  return (
    <>
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          Comparing <strong>{products.length}</strong> product{products.length === 1 ? '' : 's'}.
          Differences are highlighted in <span className="rounded bg-blue-50 px-1 font-semibold text-slate-900">blue</span>.
        </p>
        <label className="inline-flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={diffOnly}
            onChange={toggleDiff}
            className="h-4 w-4 rounded border-slate-300"
          />
          Show only differences
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-36" />
            {products.map((p) => <col key={p.id} className="w-1/4" />)}
          </colgroup>

          <tbody>
            {/* 1. PRODUCT HEADER ROW */}
            <tr className="border-b border-slate-200">
              <th
                scope="row"
                className="bg-slate-50 px-3 py-2 text-left align-top text-[10px] font-semibold uppercase tracking-wider text-slate-500"
              >
                Product
              </th>
              {products.map((p) => (
                <td key={p.id} className="border-l border-slate-100 align-top">
                  <CompareProductHeader product={p} onRemove={() => onRemove(p.id)} />
                </td>
              ))}
            </tr>

            {/* 2. RATING BREAKDOWN ROW */}
            <tr className="border-b border-slate-200">
              <th scope="row" className="bg-slate-50 px-3 py-2 text-left align-top text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Ratings
              </th>
              {products.map((p) => (
                <td key={p.id} className="border-l border-slate-100 px-3 py-2 align-top">
                  <CompareRatingBreakdown reviews={p.reviews} />
                </td>
              ))}
            </tr>

            {/* 3. ATTRIBUTE / INTRINSIC GROUPS */}
            {renderedGroups.map((g) => {
              const rows = g.attributes.map((a) => {
                const values = products.map((p) =>
                  g.kind === 'intrinsic'
                    ? readIntrinsic(p, a.key)
                    : (p.attributes[a.key] ?? null),
                );
                const diff = detectDifference(values);
                return { attr: a, values, diff };
              });
              const visible = diffOnly ? rows.filter((r) => r.diff) : rows;
              if (visible.length === 0) return null;
              return (
                <React.Fragment key={g.id}>
                  <tr className="border-y border-slate-200 bg-slate-100">
                    <th
                      scope="rowgroup"
                      colSpan={products.length + 1}
                      className="px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700"
                    >
                      {g.label}
                    </th>
                  </tr>
                  {visible.map((r) => (
                    <CompareAttributeRow
                      key={`${g.id}-${r.attr.key}`}
                      label={r.attr.label}
                      values={r.values}
                      cellKeys={products.map((p) => p.id)}
                      diff={r.diff}
                    />
                  ))}
                </React.Fragment>
              );
            })}

            {/* 4. VARIANTS ROW */}
            <tr className="border-y border-slate-200 bg-slate-100">
              <th scope="rowgroup" colSpan={products.length + 1} className="px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700">
                Variants
              </th>
            </tr>
            <tr>
              <th scope="row" className="bg-slate-50 px-3 py-2 text-left align-top text-xs font-semibold text-slate-700">Options</th>
              {products.map((p) => (
                <td key={p.id} className="border-l border-slate-100 px-3 py-2 align-top">
                  <CompareVariantsTable variants={p.variants} />
                </td>
              ))}
            </tr>

            {/* 5. ACTION ROW (always visible) */}
            <tr className="border-t-2 border-slate-300 bg-slate-50">
              <th scope="row" className="bg-slate-100 px-3 py-2 text-left align-top text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                Actions
              </th>
              {products.map((p) => (
                <td key={p.id} className="border-l border-slate-200 align-top">
                  <CompareActionRow product={p} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// React is required at runtime because we use <React.Fragment> above.
import React from 'react';
