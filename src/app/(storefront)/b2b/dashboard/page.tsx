import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { getB2BProfile } from '@/lib/b2b/apply';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';

export const dynamic = 'force-dynamic';

export default async function B2BDashboard() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/b2b/dashboard');
  const profile = await getB2BProfile(user.id);
  if (profile?.status !== 'APPROVED') redirect('/b2b/apply');

  // KPIs
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const [orderCount30, spend30, totalOrders, totalSpendAgg, openQuotes, recentOrders] = await Promise.all([
    prisma.order.count({ where: { userId: user.id, createdAt: { gte: since30 } } }),
    prisma.order.aggregate({ where: { userId: user.id, createdAt: { gte: since30 }, paymentStatus: 'VERIFIED' }, _sum: { totalPaise: true } }),
    prisma.order.count({ where: { userId: user.id } }),
    prisma.order.aggregate({ where: { userId: user.id, paymentStatus: 'VERIFIED' }, _sum: { totalPaise: true } }),
    prisma.quoteRequest.count({ where: { userId: user.id, status: 'OPEN' } }),
    prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);

  return (
    <>
      <div className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-6">
        <p className="text-xs font-bold uppercase tracking-wider text-brand-700">B2B Account</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{profile.companyName}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Tier: <strong>{profile.tier?.name ?? '—'}</strong> ({profile.tier?.discountPercent ?? 0}% off) · GSTIN: <code className="rounded bg-white px-1.5 py-0.5 font-mono">{profile.gstin}</code>
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Orders (30d)"   value={String(orderCount30)} />
        <Kpi label="Spend (30d)"    value={rupees(spend30._sum.totalPaise ?? 0)} />
        <Kpi label="Total orders"   value={String(totalOrders)} />
        <Kpi label="Lifetime spend" value={rupees(totalSpendAgg._sum.totalPaise ?? 0)} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase text-slate-700">Recent orders</h2>
            <Link href="/account/orders" className="text-xs font-semibold text-brand-700 hover:underline">All →</Link>
          </div>
          <ul className="mt-3 space-y-2">
            {recentOrders.length === 0 && <li className="text-sm text-slate-500">No orders yet.</li>}
            {recentOrders.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="block rounded-lg border border-slate-200 p-3 hover:border-brand-300">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-mono text-sm font-semibold">{o.orderNumber}</p>
                      <p className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString('en-IN')} · {o.status.replace(/_/g, ' ')}</p>
                    </div>
                    <p className="text-sm font-bold">{rupees(o.totalPaise)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold uppercase text-slate-700">Quotes &amp; bulk</h2>
          <p className="mt-3 text-sm text-slate-600">{openQuotes} open quote request{openQuotes === 1 ? '' : 's'}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/b2b/quotes/new" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">+ New quote request</Link>
            <Link href="/b2b/quotes" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">View quotes</Link>
            <Link href="/b2b/bulk" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Bulk add to cart</Link>
          </div>
        </section>
      </div>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
    </div>
  );
}
