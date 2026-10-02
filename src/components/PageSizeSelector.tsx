'use client';
/**
 * <PageSizeSelector> — Item 12. Companion dropdown for <Pagination>.
 *
 * Visible <label>, accessible association via htmlFor/id, options
 * filtered against the configured `maxPageSize` so admins can't pick
 * a size larger than the server will accept.
 *
 * Changing the size always resets to page 1 — the parent's
 * onChange handler is responsible for that reset (the spec is
 * explicit: page resets on size change).
 */
import { useId } from 'react';

export interface PageSizeSelectorProps {
  value:        number;
  onChange:     (newSize: number) => void;
  options?:     readonly number[];
  maxPageSize?: number;
  className?:   string;
}

const DEFAULT_OPTIONS = [10, 20, 50, 100] as const;

export default function PageSizeSelector({
  value, onChange, options = DEFAULT_OPTIONS, maxPageSize, className,
}: PageSizeSelectorProps): JSX.Element {
  const id = useId();
  const filtered = maxPageSize !== undefined
    ? options.filter((o) => o <= maxPageSize)
    : [...options];
  // Always include the current value even if it's outside the
  // default options (avoids a confusing empty <select> when the
  // admin override is custom).
  if (!filtered.includes(value)) {
    filtered.push(value);
    filtered.sort((a, b) => a - b);
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <label htmlFor={id} className="text-xs text-slate-600">
        Items per page:
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tap-target rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
      >
        {filtered.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}
