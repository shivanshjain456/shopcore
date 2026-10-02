'use client';
/**
 * <CompareRatingBreakdown> — Item 14.
 *
 * Horizontal stacked bar chart of 5-star → 1-star review distribution.
 * Renders nothing when the product has no approved reviews.
 *
 * Pure presentational — accepts a normalised `distribution` object
 * (already aggregated by the server).
 */
import type { CompareProduct } from '@/lib/compare/compareData';

interface Props {
  reviews: CompareProduct['reviews'];
}

const ROW_COLOURS: Record<number, string> = {
  5: 'bg-emerald-500',
  4: 'bg-emerald-400',
  3: 'bg-amber-400',
  2: 'bg-orange-400',
  1: 'bg-red-500',
};

export default function CompareRatingBreakdown({ reviews }: Props) {
  if (reviews.count === 0) {
    return <p className="text-xs italic text-slate-400">No reviews yet</p>;
  }
  const rows: Array<{ stars: 5 | 4 | 3 | 2 | 1; pct: number }> = [
    { stars: 5, pct: reviews.distribution[5] },
    { stars: 4, pct: reviews.distribution[4] },
    { stars: 3, pct: reviews.distribution[3] },
    { stars: 2, pct: reviews.distribution[2] },
    { stars: 1, pct: reviews.distribution[1] },
  ];
  return (
    <div className="space-y-1" aria-label={`Rating distribution across ${reviews.count} reviews`}>
      {rows.map((r) => (
        <div key={r.stars} className="flex items-center gap-1.5 text-[11px] text-slate-600">
          <span className="w-5 shrink-0 tabular-nums">{r.stars}★</span>
          <div className="h-1.5 flex-1 rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${ROW_COLOURS[r.stars]}`}
              style={{ width: `${Math.max(2, r.pct)}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right tabular-nums">{r.pct}%</span>
        </div>
      ))}
    </div>
  );
}
