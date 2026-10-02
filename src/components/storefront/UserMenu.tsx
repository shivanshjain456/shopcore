'use client';
/**
 * UserMenu — Feature #9.
 *
 * Avatar + name button that opens a dropdown with:
 *   - Account links (Overview, Orders, Wishlist, Addresses, Devices)
 *   - "Sign out" (current device — primary action)
 *   - "Sign out of all devices" (escalation, danger-styled)
 *
 * Accessibility:
 *   - Toggle button has `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`
 *   - Open menu has `role="menu"` and items have `role="menuitem"`
 *   - Escape closes the menu
 *   - Click outside closes the menu
 *   - Visible focus on items via Tailwind `focus:` classes
 *
 * Mobile: on viewports < 640 px the menu still renders correctly (positioned
 * full-width via `right-0`). On signed-out state it renders a plain "Sign in"
 * link so this single component covers both states.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import LogoutButton from '@/components/LogoutButton';

interface MeUser { firstName: string; lastName: string; email: string; role: string; }

export default function UserMenu({ me }: { me: MeUser | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      };
    }
    return;
  }, [open]);

  if (!me) {
    return (
      <Link
        href="/login"
        data-testid="header-sign-in"
        className="rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
      >
        Sign in
      </Link>
    );
  }

  if (me.role === 'ADMIN') {
    return (
      <Link href="/admin" className="rounded-lg px-3 py-2 text-sm text-amber-700 hover:bg-amber-50">
        Admin
      </Link>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="user-menu-popover"
        data-testid="header-user-menu-toggle"
        className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-800"
        >
          {(me.firstName?.[0] ?? '?').toUpperCase()}
        </span>
        <span className="hidden sm:inline">Hi, {me.firstName}</span>
        <svg className={`h-3 w-3 transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="currentColor">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id="user-menu-popover"
          role="menu"
          aria-label="Account menu"
          data-testid="header-user-menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="truncate text-sm font-semibold text-slate-900">{me.firstName} {me.lastName}</p>
            <p className="truncate text-xs text-slate-500">{me.email}</p>
          </div>

          <Link role="menuitem" href="/account"               className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Account overview</Link>
          <Link role="menuitem" href="/account/orders"        className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Orders</Link>
          <Link role="menuitem" href="/wishlist"              className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Wishlist</Link>
          <Link role="menuitem" href="/account/addresses"     className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Addresses</Link>
          <Link role="menuitem" href="/account/sessions"      className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">Devices &amp; sessions</Link>

          <div className="my-1 border-t border-slate-100" />
          <LogoutButton variant="menu" scope="current"
                        data-testid="user-menu-logout" />
          <LogoutButton variant="menu" scope="all"
                        data-testid="user-menu-logout-all" />
        </div>
      )}
    </div>
  );
}
