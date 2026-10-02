'use client';
/**
 * AdminShell — Feature #14 responsive admin chrome.
 *
 *   Layout per breakpoint:
 *
 *     <lg
 *       Header:  [☰] [⚙ Admin]  [Signed in as ...]      [↗ store]  [Logout]
 *       Body:    {content fills width}
 *       Drawer:  AdminSideNav (slides in on hamburger tap)
 *
 *     ≥lg
 *       Header:  [⚙ Admin]  [Signed in as ...]    [↗ store]  [Logout]
 *       Body:    [240px sidenav] [content]
 *
 *   The "Signed in as" tag also shrinks to just the email on < md to keep
 *   the header row from wrapping awkwardly on phones.
 *
 *   Touch targets:
 *     - hamburger: tap-target (44×44)
 *     - "View storefront" link: tap-target
 *     - LogoutButton: already a tap-target via its own utility class
 *
 *   The drawer auto-closes when the route changes (so clicking any nav
 *   link in the drawer dismisses it).
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import AdminSideNav from '@/components/admin/SideNav';
import LogoutButton from '@/components/LogoutButton';
import MobileNavDrawer from '@/components/MobileNavDrawer';

interface Props {
  email: string;
  children: React.ReactNode;
}

export default function AdminShell({ email, children }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const path = usePathname();

  // Auto-close the drawer whenever the URL changes — when the admin taps
  // a nav link, the route updates and the drawer should disappear.
  useEffect(() => { setDrawerOpen(false); }, [path]);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-2.5">
          {/* Hamburger — visible only below lg. */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open admin menu"
            aria-expanded={drawerOpen}
            aria-controls="admin-mobile-drawer"
            data-testid="admin-menu-button"
            className="tap-target inline-flex items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 lg:hidden"
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>

          <Link href="/admin" className="flex items-center gap-2 font-bold">
            <span className="grid h-7 w-7 place-items-center rounded bg-amber-500 text-white" aria-hidden="true">⚙</span>
            <span className="hidden text-slate-900 sm:inline">ShopCore admin</span>
          </Link>

          {/* "Signed in as ..." — collapses to just email on phones to save room. */}
          <span className="ml-auto truncate text-xs text-slate-500" title={email}>
            <span className="hidden sm:inline">Signed in as </span>
            <strong>{email}</strong>
          </span>

          <Link
            href="/"
            className="tap-target inline-flex items-center rounded-md border border-slate-300 px-2.5 text-xs hover:bg-slate-50"
            aria-label="View storefront in a new tab"
          >
            <span className="hidden sm:inline">View storefront&nbsp;</span>↗
          </Link>
          <LogoutButton />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1400px] gap-4 px-3 py-4 sm:px-4 lg:grid-cols-[240px_1fr]">
        <aside className="hidden h-fit rounded-xl border border-slate-200 bg-white p-3 lg:block">
          <AdminSideNav />
        </aside>
        <section className="min-w-0">{children}</section>
      </div>

      <MobileNavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Admin"
        data-testid="admin-mobile-drawer"
      >
        <AdminSideNav />
      </MobileNavDrawer>
    </div>
  );
}
