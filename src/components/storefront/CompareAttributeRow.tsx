'use client';
/**
 * <CompareAttributeRow> — Item 14.
 *
 * One label-plus-cells row inside a compare-table category. Handles:
 *   - missing values → "—"
 *   - array values   → comma-separated
 *   - boolean values → Yes / No
 *   - {value,unit}   → "1500 g"
 *   - difference highlighting via `diff` prop
 */
import type { ReactNode } from 'react';

interface Props {
  label:  string;
  values: unknown[];
  /** Stable keys for each value cell — one per product, same order as
   *  `values`. Used for React reconciliation across re-renders so we
   *  don't fall back to array-index keys (edge-case D7.4). */
  cellKeys: string[];
  /** True when the value cells differ across products. */
  diff:   boolean;
}

function formatCell(raw: unknown): ReactNode {
  if (raw === null || raw === undefined || raw === '') return <span className="text-slate-400">—</span>;
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (Array.isArray(raw)) {
    if (raw.length === 0) return <span className="text-slate-400">—</span>;
    return raw.map((v) => formatScalar(v)).join(', ');
  }
  if (typeof raw === 'object') {
    const obj = raw as { value?: unknown; unit?: unknown };
    if ('value' in obj || 'unit' in obj) {
      const v = formatScalar(obj.value);
      const u = obj.unit !== undefined && obj.unit !== '' ? ` ${String(obj.unit)}` : '';
      return `${v}${u}`;
    }
    return JSON.stringify(raw);
  }
  return formatScalar(raw);
}

function formatScalar(raw: unknown): string {
  if (raw === null || raw === undefined) return '—';
  return String(raw);
}

export default function CompareAttributeRow({ label, values, cellKeys, diff }: Props) {
  return (
    <tr>
      <th scope="row" className="bg-slate-50 px-3 py-2 text-left align-top text-xs font-semibold text-slate-700">
        {label}
      </th>
      {values.map((v, i) => {
        const isMissing = v === null || v === undefined || v === '';
        const cls = [
          'border-l align-top px-3 py-2 text-sm',
          diff && !isMissing ? 'border-l-4 border-blue-500 bg-blue-50 font-semibold text-slate-900' : 'border-slate-100 text-slate-700',
        ].join(' ');
        return <td key={cellKeys[i] ?? `cell-${i}`} className={cls}>{formatCell(v)}</td>;
      })}
    </tr>
  );
}
