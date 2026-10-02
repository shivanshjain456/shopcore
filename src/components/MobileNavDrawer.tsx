'use client';
/**
 * MobileNavDrawer — Feature #14.
 *
 *   A left-edge slide-in nav drawer for small screens. Built on the native
 *   `<dialog>` element so we get for free:
 *     - real focus trap when opened via `showModal()`
 *     - native Escape-to-close
 *     - top-layer rendering (always above stacking contexts)
 *     - proper role="dialog" / aria-modal semantics
 *
 *   Behaviour:
 *     - Animates in/out via keyframes defined in globals.css.
 *     - Clicking the backdrop closes the drawer.
 *     - Closes itself automatically on viewport resize past `lg` (1024 px)
 *       so a user who rotates / zooms doesn't end up with both the
 *       desktop nav AND the drawer visible.
 *     - Restores body scroll on close (the native <dialog> top-layer
 *       handles this for us).
 *
 *   Accessibility:
 *     - aria-label on the dialog
 *     - first focusable child auto-focused by the browser when showModal()
 *       runs (the native dialog focus algorithm)
 *     - close button is `aria-label="Close menu"` with a 44×44 tap target
 *     - prefers-reduced-motion respected via globals.css overrides
 */
import React, { useCallback, useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Drawer contents (caller-controlled). */
  children: React.ReactNode;
  /** Optional heading text shown at the top of the drawer. */
  title?: string;
  /** Test hook. */
  'data-testid'?: string;
}

export default function MobileNavDrawer({
  open, onClose, children, title = 'Menu', 'data-testid': testId = 'mobile-nav-drawer',
}: Props) {
  const dlgRef = useRef<HTMLDialogElement | null>(null);

  // Sync component state ↔ <dialog> open state.
  useEffect(() => {
    const d = dlgRef.current;
    if (!d) return;
    if (open && !d.open) {
      try { d.showModal(); } catch { /* showModal can throw on duplicate */ }
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Close on Escape (also handled natively, but we re-bind so the parent's
  // onClose runs deterministically).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Close on viewport reaching lg (1024 px) — the desktop nav takes over.
  useEffect(() => {
    if (!open) return;
    const mql = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (('matches' in e ? e.matches : false)) onClose();
    };
    if (mql.matches) onClose();
    mql.addEventListener?.('change', handler as (e: MediaQueryListEvent) => void);
    return () => mql.removeEventListener?.('change', handler as (e: MediaQueryListEvent) => void);
  }, [open, onClose]);

  // Clicking the backdrop closes — the backdrop click event target IS the
  // dialog element itself (not the drawer panel), so we detect that.
  const onDlgClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <dialog
      ref={dlgRef}
      aria-label={title}
      onClick={onDlgClick}
      data-testid={testId}
      className={[
        'app-dialog mobile-drawer',
        // Override the centered shape that `app-dialog` would give us —
        // make it a left-docked panel instead.
        'm-0 h-full max-h-full w-[min(86vw,20rem)] max-w-none',
        'rounded-none border-0 rounded-r-2xl',
        'p-0',
      ].join(' ')}
      style={{
        // Pin to the left edge. Native <dialog> centres by default;
        // overriding `margin: auto` here docks it to the start.
        marginLeft: 0, marginRight: 'auto',
        // Honour the iOS safe-area inset so the drawer doesn't slip
        // under the notch / Dynamic Island.
        paddingTop: 'max(8px, var(--safe-top))',
        paddingBottom: 'max(8px, var(--safe-bottom))',
      }}
    >
      <div className="flex h-full min-h-0 flex-col bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-base font-bold text-slate-900">{title}</p>
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            data-testid={`${testId}-close`}
            className="tap-target inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {children}
        </div>
      </div>
    </dialog>
  );
}
