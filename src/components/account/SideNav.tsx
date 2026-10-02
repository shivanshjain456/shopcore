'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import LogoutButton from '@/components/LogoutButton';

const ITEMS: Array<{ href: string; label: string }> = [
  { href: '/account',                label: 'Overview' },
  { href: '/account/orders',         label: 'Orders' },
  { href: '/account/returns',        label: 'Returns & exchanges' },
  { href: '/account/reviews',        label: 'My reviews' },
  { href: '/account/addresses',      label: 'Addresses' },
  { href: '/account/saved-carts',    label: 'Saved carts' },
  { href: '/wishlist',               label: 'Wishlist' },
  { href: '/account/loyalty',        label: 'Loyalty & rewards' },
  { href: '/account/referrals',      label: 'Referrals' },
  { href: '/account/subscriptions',  label: 'Subscriptions' },
  { href: '/account/support',        label: 'Support tickets' },
  { href: '/account/chat',           label: 'Live chat' },
  { href: '/account/sessions',       label: 'Devices & sessions' },
  { href: '/compare',                label: 'Compare products' },
];

export default function SideNav() {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {ITEMS.map((i) => {
        const active = path === i.href || (i.href !== '/account' && path.startsWith(i.href));
        return (
          <Link key={i.href} href={i.href}
                className={`block rounded-md px-3 py-1.5 text-sm ${active ? 'bg-brand-50 font-semibold text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`}>
            {i.label}
          </Link>
        );
      })}
      {/* Feature #9 — Sign out is always visible at the bottom of the
          account sidebar, on every account page. */}
      <div className="mt-3 border-t border-slate-100 pt-2" data-testid="account-signout">
        <LogoutButton variant="menu" scope="current" />
      </div>
    </nav>
  );
}
