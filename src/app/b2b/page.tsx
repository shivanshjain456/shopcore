import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getB2BProfile } from '@/lib/b2b/apply';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export default async function B2BLanding() {
  const user = await getCurrentUser();
  const profile = user ? await getB2BProfile(user.id) : null;
  const tiers = await prisma.b2BTier.findMany({ where: { isActive: true }, orderBy: { discountPercent: 'asc' } });

  const cta =
    !user ? { href: '/login?next=/b2b/apply', label: 'Sign in to apply' }
  : profile?.status === 'APPROVED' ? { href: '/b2b/dashboard', label: 'Go to B2B dashboard →' }
  : profile?.status === 'PENDING'  ? { href: '/b2b/apply',     label: 'View pending application' }
                                   : { href: '/b2b/apply',     label: 'Apply for B2B account' };

  return (
    <main className="bg-gradient-to-br from-brand-50 via-white to-slate-50">
      <section className="mx-auto max-w-6xl px-4 py-16">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">B2B Portal · India</p>
        <h1 className="mt-2 text-4xl font-extrabold tracking-tight text-slate-900">Bulk pricing for businesses.</h1>
        <p className="mt-3 max-w-2xl text-slate-600">
          GSTIN-verified business accounts unlock tier-based discounts across the catalogue, full GST invoicing,
          quote-request workflow for large orders, and bulk-add shortcuts.
        </p>
        <div className="mt-6">
          <Link href={cta.href} className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700">
            {cta.label}
          </Link>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {tiers.map((t) => (
            <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs uppercase text-slate-500">Tier</p>
              <h3 className="mt-1 text-xl font-bold text-slate-900">{t.name}</h3>
              <p className="mt-2 text-3xl font-extrabold text-brand-700">{t.discountPercent}% <span className="text-sm font-medium text-slate-500">off</span></p>
              <p className="mt-1 text-xs text-slate-500">
                Min order: ₹{(t.minOrderPaise / 100).toLocaleString('en-IN')}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['GSTIN verified', 'Format + checksum validation before activation.'],
            ['Quote requests',  'Send multi-line RFQs; get a counter-quote you can accept in one click.'],
            ['GST invoices',    'Download GST-compliant invoices for every order.'],
            ['Bulk ordering',   'Paste SKU/qty list and add 50+ items in one go.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-bold text-slate-900">{t}</p>
              <p className="mt-1 text-xs text-slate-600">{d}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
