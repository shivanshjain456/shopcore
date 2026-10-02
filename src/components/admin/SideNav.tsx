'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: Array<{ label: string; items: { href: string; label: string }[] }> = [
  { label: 'Overview',  items: [
    { href: '/admin',                label: 'Dashboard' },
    { href: '/admin/analytics',      label: 'Analytics' },
    { href: '/admin/audit-log',      label: 'Audit log' },
  ]},
  { label: 'Catalog',   items: [
    { href: '/admin/products',       label: 'Products' },
    { href: '/admin/categories',     label: 'Categories' },
    { href: '/admin/brands',         label: 'Brands' },
    { href: '/admin/inventory',      label: 'Inventory' },
    { href: '/admin/bundles',        label: 'Bundles' },
    { href: '/admin/excel',          label: 'Excel import/export' },
  ]},
  { label: 'Operations', items: [
    { href: '/admin/orders',         label: 'Orders' },
    { href: '/admin/returns',        label: 'Returns' },
    { href: '/admin/reviews',        label: 'Reviews' },
    { href: '/admin/tickets',        label: 'Support tickets' },
    { href: '/admin/chat',           label: 'Live chat' },
  ]},
  { label: 'Customers', items: [
    { href: '/admin/customers',      label: 'All customers' },
    { href: '/admin/b2b',            label: 'B2B applications' },
    { href: '/admin/quotes',         label: 'Quote requests' },
  ]},
  { label: 'Marketing', items: [
    { href: '/admin/hero-banners',   label: 'Hero carousel' },
    { href: '/admin/coupons',        label: 'Coupons' },
    { href: '/admin/promotions',     label: 'Promotions' },
    { href: '/admin/campaigns',      label: 'Email campaigns' },
    { href: '/admin/push',           label: 'Push notifications' },
  ]},
  { label: 'Settings',  items: [
    { href: '/admin/store-config',   label: 'Store config' },
    { href: '/admin/assets',         label: 'Assets' },
    { href: '/admin/homepage',       label: 'Homepage CMS' },
    { href: '/admin/jobs',           label: 'Background jobs' },
  ]},
];

export default function AdminSideNav() {
  const path = usePathname();
  return (
    <nav className="space-y-4 text-sm">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{g.label}</p>
          <div className="space-y-0.5">
            {g.items.map((i) => {
              const active = path === i.href || (i.href !== '/admin' && path.startsWith(i.href));
              return (
                <Link key={i.href} href={i.href}
                  className={`block rounded-md px-3 py-1.5 ${active ? 'bg-amber-50 font-semibold text-amber-900' : 'text-slate-700 hover:bg-slate-100'}`}>
                  {i.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
