/**
 * ResponsiveTable — Feature #14.
 *
 *   A thin wrapper that gives any table:
 *     - a horizontal scroll lane on small screens (no page overflow),
 *     - momentum scrolling on touch devices,
 *     - a stable scrollbar gutter so the layout doesn't jump when the
 *       scrollbar appears/disappears.
 *
 *   Usage (drop-in around an existing <table>):
 *
 *     <ResponsiveTable ariaLabel="Orders">
 *       <table>
 *         <thead>…</thead>
 *         <tbody>…</tbody>
 *       </table>
 *     </ResponsiveTable>
 *
 *   Why a wrapper instead of a styled <table>?
 *     - Tables can't natively scroll; CSS overflow on the table itself does
 *       not constrain row layout. The widely-used pattern is a `div { overflow:
 *       auto }` parent that contains the table.
 *     - We tag the wrapper with `role="region"` + `tabindex={0}` so the
 *       scrollable area is reachable by keyboard and announced as a
 *       landmark to screen readers (per WAI authoring practices).
 *
 *   For dense admin tables that don't fit on phones, consider rendering
 *   a card-list layout below `md` instead — this component only handles
 *   the scroll-fallback path, which is the safer default.
 */
import React, { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Required for accessibility — announces the scroll region. */
  ariaLabel: string;
  className?: string;
  /** Optional caption rendered above the table for screen readers. */
  caption?: string;
  'data-testid'?: string;
}

export default function ResponsiveTable({
  children, ariaLabel, className = '', caption,
  'data-testid': testId = 'responsive-table',
}: Props) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      data-testid={testId}
      className={`table-scroll rounded-lg border border-slate-200 bg-white ${className}`}
    >
      {caption && (
        <p className="sr-only" data-testid={`${testId}-caption`}>{caption}</p>
      )}
      {children}
    </div>
  );
}
