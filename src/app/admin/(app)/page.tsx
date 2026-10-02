import Link from 'next/link';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';

export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 86400_000);

  const [
    customers, b2bApproved, productCount, lowStock, pendingPayments, pendingReturns,
    openTickets, openQuotes, pendingApps, ordersToday, salesToday, sales30,
    salesPending, recentOrders, recentAudits,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
    prisma.user.count({ where: { role: 'B2B', b2bApprovedAt: { not: null } } }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.product.count({ where: { isActive: true, stock: { lte: 5 } } }),
    prisma.order.count({ where: { paymentStatus: 'AWAITING_VERIFICATION' } }),
    prisma.returnRequest.count({ where: { status: 'REQUESTED' } }),
    prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'AWAITING_AGENT'] } } }),
    prisma.quoteRequest.count({ where: { status: 'OPEN' } }),
    prisma.user.count({ where: { companyName: { not: null }, gstin: { not: null }, role: { not: 'B2B' }, b2bApprovedAt: null } }),
    prisma.order.count({ where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } } }),
    prisma.order.aggregate({ _sum: { totalPaise: true }, where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) }, paymentStatus: 'VERIFIED' } }),
    prisma.order.aggregate({ _sum: { totalPaise: true }, where: { createdAt: { gte: since30 }, paymentStatus: 'VERIFIED' } }),
    prisma.order.aggregate({ _sum: { totalPaise: true }, where: { paymentStatus: 'AWAITING_VERIFICATION' } }),
    prisma.order.findMany({
      take: 8, orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    }),
    prisma.auditLog.findMany({ take: 12, orderBy: { createdAt: 'desc' }, include: { actor: { select: { email: true } } } }),
  ]);

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
      <p className="text-sm text-slate-600">Welcome back. Live numbers across the store.</p>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Sales today"    value={rupees(salesToday._sum.totalPaise ?? 0)} sub={`${ordersToday} order${ordersToday === 1 ? '' : 's'}`} />
        <Kpi label="Sales (30d)"    value={rupees(sales30._sum.totalPaise ?? 0)} />
        <Kpi label="Pending payment" value={rupees(salesPending._sum.totalPaise ?? 0)} sub={`${pendingPayments} order${pendingPayments === 1 ? '' : 's'}`} accent="amber" />
        <Kpi label="Active products" value={String(productCount)} sub={`${lowStock} low stock`} accent={lowStock > 0 ? 'red' : undefined} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Customers"     value={String(customers)} />
        <Kpi label="B2B accounts"  value={String(b2bApproved)} sub={`${pendingApps} pending`} accent={pendingApps > 0 ? 'amber' : undefined} />
        <Kpi label="Open tickets"  value={String(openTickets)} accent={openTickets > 0 ? 'amber' : undefined} />
        <Kpi label="Open quotes"   value={String(openQuotes)} accent={openQuotes > 0 ? 'amber' : undefined} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-2">
        <ActionCard label="Verify pending payments" count={pendingPayments} href="/admin/orders?status=PENDING_PAYMENT_REVIEW" />
        <ActionCard label="Approve B2B applications" count={pendingApps} href="/admin/b2b" />
        <ActionCard label="Handle return requests"  count={pendingReturns} href="/admin/returns?status=REQUESTED" />
        <ActionCard label="Answer open quotes"      count={openQuotes} href="/admin/quotes" />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_360px]">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase text-slate-700">Recent orders</h2>
            <Link href="/admin/orders" className="text-xs font-semibold text-brand-700 hover:underline">All →</Link>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="px-2 py-1.5 text-left">Order</th><th className="px-2 py-1.5 text-left">Customer</th><th className="px-2 py-1.5 text-left">Status</th><th className="px-2 py-1.5 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentOrders.map((o) => (
                <tr key={o.id}>
                  <td className="px-2 py-1.5 font-mono text-xs"><Link href={`/admin/orders/${o.id}`} className="text-brand-700 hover:underline">{o.orderNumber}</Link></td>
                  <td className="px-2 py-1.5 text-xs">{o.user.email}</td>
                  <td className="px-2 py-1.5 text-xs">{o.status.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-1.5 text-right text-xs font-semibold">{rupees(o.totalPaise)}</td>
                </tr>
              ))}
              {recentOrders.length === 0 && <tr><td colSpan={4} className="px-2 py-4 text-center text-slate-500">No orders yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase text-slate-700">Audit log</h2>
            <Link href="/admin/audit-log" className="text-xs font-semibold text-brand-700 hover:underline">All →</Link>
          </div>
          <ul className="mt-3 space-y-2 text-xs">
            {recentAudits.length === 0 && <li className="text-slate-500">Nothing yet.</li>}
            {recentAudits.map((a) => (
              <li key={a.id} className="border-b border-slate-100 pb-1.5">
                <p><span className="font-semibold">{a.action}</span> on <code className="font-mono">{a.entity}</code></p>
                <p className="text-[10px] text-slate-500">{a.actor.email} · {new Date(a.createdAt).toLocaleString('en-IN')}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'amber' | 'red' }) {
  const ring = accent === 'amber' ? 'border-amber-200 bg-amber-50' : accent === 'red' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-xl border p-4 ${ring}`}>
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function ActionCard({ label, count, href }: { label: string; count: number; href: string }) {
  return (
    <Link href={href} className={`flex items-center justify-between rounded-xl border p-4 transition ${count > 0 ? 'border-amber-300 bg-amber-50 hover:border-amber-400' : 'border-slate-200 bg-white hover:border-brand-300'}`}>
      <span className="font-semibold text-slate-800">{label}</span>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${count > 0 ? 'bg-amber-200 text-amber-900' : 'bg-slate-200 text-slate-600'}`}>{count}</span>
    </Link>
  );
}
