import { computeKpis } from '@/lib/admin/analytics';
import { rupees } from '@/lib/catalog/pricing';
import { Card, PageHeader } from '@/components/admin/Helpers';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const k = await computeKpis();
  const maxRev = Math.max(1, ...k.revenueByDay.map((d) => d.revenuePaise));

  return (
    <>
      <PageHeader title="Analytics" subtitle="Live KPIs across the last 30 days." />
      <div className="grid gap-3 md:grid-cols-4">
        <Kpi label="Revenue (30d)" value={rupees(k.revenue30Paise)} />
        <Kpi label="Orders (30d)" value={String(k.ordersCount30)} />
        <Kpi label="Avg order value" value={rupees(k.averageOrderValuePaise)} />
        <Kpi label="Conversion rate" value={`${k.conversionRate}%`} />
        <Kpi label="Customer lifetime value" value={rupees(k.customerLifetimeValuePaise)} />
      </div>

      <Card className="mt-3">
        <h2 className="text-sm font-bold uppercase text-slate-700">Revenue trend (30d)</h2>
        <div className="mt-3 flex h-32 items-end gap-0.5">
          {k.revenueByDay.map((d) => (
            <div key={d.date} className="group relative flex-1 bg-brand-100" style={{ height: `${(d.revenuePaise / maxRev) * 100}%`, minHeight: '2px' }} title={`${d.date}: ${rupees(d.revenuePaise)} (${d.orders} orders)`}>
              <div className="h-full w-full rounded-t bg-brand-600 opacity-80 group-hover:opacity-100" />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>{k.revenueByDay[0]?.date}</span><span>{k.revenueByDay.at(-1)?.date}</span></div>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="overflow-x-auto">
          <h2 className="text-sm font-bold uppercase text-slate-700">Top products (30d)</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">Product</th><th className="px-2 py-1 text-right">Units</th><th className="px-2 py-1 text-right">Revenue</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {k.topProducts.map((p) => (<tr key={p.id}><td className="px-2 py-1">{p.name}<br/><span className="font-mono text-[10px] text-slate-500">{p.sku}</span></td><td className="px-2 py-1 text-right font-semibold">{p.unitsSold}</td><td className="px-2 py-1 text-right">{rupees(p.revenuePaise)}</td></tr>))}
              {k.topProducts.length === 0 && <tr><td colSpan={3} className="p-3 text-center text-slate-500">No verified orders yet.</td></tr>}
            </tbody>
          </table>
        </Card>

        <Card className="overflow-x-auto">
          <h2 className="text-sm font-bold uppercase text-slate-700">Inventory forecast</h2>
          <p className="text-xs text-slate-500">Days-of-stock based on last-30-day velocity. Sorted by what runs out soonest.</p>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-left">Name</th><th className="px-2 py-1 text-right">Stock</th><th className="px-2 py-1 text-right">Per week</th><th className="px-2 py-1 text-right">Days left</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {k.inventoryForecast.map((r) => (<tr key={r.sku}><td className="px-2 py-1 font-mono text-xs">{r.sku}</td><td className="px-2 py-1">{r.name}</td><td className="px-2 py-1 text-right">{r.stock}</td><td className="px-2 py-1 text-right">{r.weeklyVelocity}</td><td className={`px-2 py-1 text-right font-semibold ${r.daysOfStock < 14 ? 'text-red-700' : ''}`}>{r.daysOfStock < 9999 ? r.daysOfStock : '∞'}</td></tr>))}
              {k.inventoryForecast.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-slate-500">No data.</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className="mt-1 text-2xl font-extrabold">{value}</p></div>;
}
