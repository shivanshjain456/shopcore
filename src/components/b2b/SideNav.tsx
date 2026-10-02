'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/b2b/dashboard', label: 'Overview' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/b2b/quotes',    label: 'Quote requests' },
  { href: '/b2b/bulk',      label: 'Bulk order' },
  { href: '/b2b/apply',     label: 'Business profile' },
];

export default function B2BSideNav() {
  const path = usePathname();
  return (
    <nav className="space-y-0.5">
      {ITEMS.map((i) => {
        const active = path === i.href || (i.href !== '/b2b/dashboard' && path.startsWith(i.href));
        return (
          <Link key={i.href} href={i.href}
                className={`block rounded-md px-3 py-1.5 text-sm ${active ? 'bg-brand-50 font-semibold text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
