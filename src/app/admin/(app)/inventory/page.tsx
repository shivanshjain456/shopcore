import Link from 'next/link';
import { prisma } from '@/lib/db/client';
import { Card, PageHeader, StatusBadge } from '@/components/admin/Helpers';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const [products, variants, recentLog] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, orderBy: { stock: 'asc' }, take: 200, include: { category: { select: { name: true } } } }),
    prisma.variant.findMany({ where: { isActive: true }, orderBy: { stock: 'asc' }, take: 200, include: { product: { select: { name: true, sku: true } } } }),
    prisma.inventoryLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  return (
    <>
      <PageHeader
        title="Inventory" subtitle="Stock per product + variant; recent adjustments."
        actions={<Link href="/admin/excel" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Bulk update via Excel</Link>}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="overflow-x-auto">
          <h2 className="mb-2 text-sm font-bold uppercase text-slate-700">Products</h2>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-left">Name</th><th className="px-2 py-1 text-right">Stock</th><th className="px-2 py-1 text-right">Low at</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {products.map((p) => (
                <tr key={p.id}>
                  <td className="px-2 py-1 font-mono text-xs">{p.sku}</td>
                  <td className="px-2 py-1"><Link href={`/admin/products/${p.id}`} className="text-brand-700 hover:underline">{p.name}</Link><br/><span className="text-[10px] text-slate-500">{p.category.name}</span></td>
                  <td className={`px-2 py-1 text-right font-semibold ${p.stock <= p.lowStockAt ? 'text-red-700' : ''}`}>{p.stock}</td>
                  <td className="px-2 py-1 text-right text-xs text-slate-500">{p.lowStockAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="overflow-x-auto">
          <h2 className="mb-2 text-sm font-bold uppercase text-slate-700">Variants</h2>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-left">Variant</th><th className="px-2 py-1 text-right">Stock</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {variants.map((v) => (
                <tr key={v.id}>
                  <td className="px-2 py-1 font-mono text-xs">{v.sku}</td>
                  <td className="px-2 py-1">{v.product.name} <span className="text-xs text-slate-500">· {v.name}</span></td>
                  <td className={`px-2 py-1 text-right font-semibold ${v.stock <= 5 ? 'text-red-700' : ''}`}>{v.stock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <Card className="mt-3 overflow-x-auto">
        <h2 className="mb-2 text-sm font-bold uppercase text-slate-700">Recent inventory changes</h2>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">When</th><th className="px-2 py-1 text-left">Reason</th><th className="px-2 py-1 text-right">Delta</th><th className="px-2 py-1 text-left">Ref</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {recentLog.map((l) => (
              <tr key={l.id}>
                <td className="px-2 py-1 text-xs">{new Date(l.createdAt).toLocaleString('en-IN')}</td>
                <td className="px-2 py-1"><StatusBadge s={l.reason} /></td>
                <td className={`px-2 py-1 text-right font-semibold ${l.delta < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{l.delta > 0 ? '+' : ''}{l.delta}</td>
                <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{l.refId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
