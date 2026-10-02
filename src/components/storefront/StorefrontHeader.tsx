'use client';
/**
 * StorefrontHeader — Feature #14 responsive overhaul.
 *
 *   ──────────────────────────────────────────────────────────────────
 *   Layout per breakpoint:
 *
 *     <lg (mobile + tablet)
 *       Row 1:  [☰ menu]   [SC logo]                  [Cart]
 *       Row 2:  [────────  full-width search  ──────────────]
 *       (CategoryStrip keeps its horizontal-scroll lane)
 *
 *     ≥lg (desktop)
 *       Row 1:  [SC ShopCore]  [search]  [Wishlist] [Orders] [Avatar] [Cart]
 *       (no second row)
 *   ──────────────────────────────────────────────────────────────────
 *
 *   Why a separate row for search on mobile?
 *     - The search input needs ≥ 200 px to be usable on phones; sharing
 *       the top row with nav + cart squeezed it to ~120 px on 320 px
 *       devices, which is unusable.
 *
 *   Touch targets: every clickable on the top row meets the WCAG 44×44
 *   minimum via the `tap-target` utility.
 *
 *   The mobile drawer (<MobileNavDrawer>) hosts: Wishlist, My account,
 *   Orders, Sign in / Create account (when logged out), category links,
 *   and the B2B portal link. Closes on any link click via the parent's
 *   `setOpen(false)` handler.
 */
import Link from 'next/link';
import { useCart } from './CartProvider';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import UserMenu from './UserMenu';
import MobileNavDrawer from '@/components/MobileNavDrawer';
import StoreLogo from './StoreLogo';

interface MeUser { firstName: string; lastName: string; email: string; role: string; }

interface StorefrontHeaderProps {
  storeName: string;
  logoUrl:   string;
  logoAlt:   string;
}

export default function StorefrontHeader({ storeName, logoUrl, logoAlt }: StorefrontHeaderProps) {
  const { unitCount, loaded } = useCart();
  const [me, setMe] = useState<MeUser | null>(null);
  const [q, setQ] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cats, setCats] = useState<{ name: string; slug: string }[]>([]);

  useEffect(() => {
    (async () => {
      const r = await api<{ user: MeUser }>('/api/auth/me');
      if (r.ok && r.data) setMe(r.data.user);
    })();
    (async () => {
      const r = await api<{ categories: { name: string; slug: string }[] }>('/api/categories');
      if (r.ok && r.data) setCats(r.data.categories);
    })();
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      {/* Top row */}
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-2 sm:px-4 sm:py-3">
        {/* Hamburger — hidden on lg+ */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls="storefront-mobile-drawer"
          data-testid="header-menu-button"
          className="tap-target inline-flex items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 lg:hidden"
        >
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>

        {/* Item 17 — store logo from admin config, with a designed
            inline-SVG fallback when no logo URL is set. Smaller on
            mobile (32px) to keep the row tight. */}
        <span className="sm:hidden">
          <StoreLogo storeName={storeName} logoUrl={logoUrl} logoAlt={logoAlt} height={32} />
        </span>
        <span className="hidden sm:inline">
          <StoreLogo storeName={storeName} logoUrl={logoUrl} logoAlt={logoAlt} height={40} />
        </span>

        {/* Desktop-only inline search (mobile uses the full-width search row below). */}
        <form
          action="/search" method="GET" role="search"
          aria-label="Search products"
          className="ml-2 hidden flex-1 lg:block"
          onSubmit={(e) => { if (!q.trim()) e.preventDefault(); }}
        >
          <SearchInput q={q} setQ={setQ} />
        </form>

        {/* Spacer for mobile (no inline search) so cart pushes to the right. */}
        <div className="flex-1 lg:hidden" aria-hidden="true" />

        {/* Desktop secondary nav. Hidden below lg in favour of the drawer. */}
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Account navigation">
          <Link href="/wishlist" className="tap-target inline-flex items-center rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-100">
            Wishlist
          </Link>
          {me && me.role !== 'ADMIN' && (
            <Link href="/account/orders" className="tap-target inline-flex items-center rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-100">
              Orders
            </Link>
          )}
          <UserMenu me={me} />
        </nav>

        <Link
          href="/cart"
          aria-label={loaded && unitCount > 0 ? `Cart, ${unitCount} item${unitCount === 1 ? '' : 's'}` : 'Cart'}
          className="tap-target relative inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 4h2l3 12h12l2-8H6" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="10" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>
          </svg>
          <span className="hidden sm:inline">Cart</span>
          {loaded && unitCount > 0 && (
            <span className="ml-1 grid min-w-6 place-items-center rounded-full bg-white px-1.5 text-xs font-bold text-brand-700">
              {unitCount}
            </span>
          )}
        </Link>
      </div>

      {/* Mobile-only full-width search row (≤ lg). */}
      <div className="border-t border-slate-100 px-3 py-2 lg:hidden">
        <form
          action="/search" method="GET" role="search"
          aria-label="Search products"
          onSubmit={(e) => { if (!q.trim()) e.preventDefault(); }}
        >
          <SearchInput q={q} setQ={setQ} />
        </form>
      </div>

      <CategoryStrip cats={cats} />

      <MobileNavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="ShopCore"
        data-testid="mobile-nav-drawer"
      >
        <DrawerContents
          me={me}
          cats={cats}
          onNavigate={() => setDrawerOpen(false)}
        />
      </MobileNavDrawer>
    </header>
  );
}

function SearchInput({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  return (
    <div className="relative">
      <input
        type="search"
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search laptops, desktops, accessories…"
        aria-label="Search"
        className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-base shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:text-sm"
        autoComplete="off"
      />
      <svg className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-400 sm:top-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function CategoryStrip({ cats }: { cats: { name: string; slug: string }[] }) {
  // Horizontal scroll on every breakpoint — categories are inherently
  // wide content and the strip is dense by design. The wrapper `overflow-x-auto`
  // contains the scroll to JUST this strip so it never overflows the page.
  return (
    <div className="border-t border-slate-100 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-3 py-1.5 text-sm sm:px-4">
        <Link href="/" className="rounded px-2 py-1 font-medium text-slate-700 hover:bg-slate-100">All</Link>
        {cats.map((c) => (
          <Link key={c.slug} href={`/c/${c.slug}`} className="whitespace-nowrap rounded px-2 py-1 text-slate-600 hover:bg-slate-100">
            {c.name}
          </Link>
        ))}
        <Link href="/b2b" className="ml-auto whitespace-nowrap rounded px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50">
          For business →
        </Link>
      </div>
    </div>
  );
}

function DrawerContents({
  me, cats, onNavigate,
}: {
  me: MeUser | null;
  cats: { name: string; slug: string }[];
  onNavigate: () => void;
}) {
  const linkCls = 'block tap-target rounded-md px-3 py-2 text-base text-slate-800 hover:bg-slate-100';
  return (
    <div className="space-y-4 text-sm">
      {/* Account quick block */}
      <section>
        <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Account</p>
        {me ? (
          <>
            <Link href="/account" onClick={onNavigate} className={linkCls}>My account</Link>
            <Link href="/account/orders" onClick={onNavigate} className={linkCls}>My orders</Link>
            <Link href="/wishlist" onClick={onNavigate} className={linkCls}>Wishlist</Link>
            <Link href="/account/addresses" onClick={onNavigate} className={linkCls}>Addresses</Link>
          </>
        ) : (
          <>
            <Link href="/login" onClick={onNavigate} className={linkCls}>Sign in</Link>
            <Link href="/signup" onClick={onNavigate} className={linkCls}>Create account</Link>
            <Link href="/wishlist" onClick={onNavigate} className={linkCls}>Wishlist</Link>
          </>
        )}
      </section>

      {/* Categories block */}
      <section>
        <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Shop</p>
        <Link href="/" onClick={onNavigate} className={linkCls}>All products</Link>
        {cats.map((c) => (
          <Link key={c.slug} href={`/c/${c.slug}`} onClick={onNavigate} className={linkCls}>{c.name}</Link>
        ))}
      </section>

      <section>
        <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">More</p>
        <Link href="/b2b" onClick={onNavigate} className={linkCls}>For business</Link>
        <Link href="/cart" onClick={onNavigate} className={linkCls}>Cart</Link>
      </section>
    </div>
  );
}
