import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';

export const dynamic = 'force-dynamic';

export default async function ReturnDetail({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/account/returns/${params.id}`);
  const r = await prisma.returnRequest.findUnique({
    where: { id: params.id },
    include: { order: { select: { id: true, orderNumber: true } } },
  });
  if (!r || r.userId !== user.id) notFound();
  const items = JSON.parse(r.itemsJson) as Array<{ productName: string; variantName: string | null; quantity: number; unitPricePaise: number }>;
  const imgs = r.imagesJson ? JSON.parse(r.imagesJson) as string[] : [];
  return (
    <>
      <nav className="text-xs text-slate-500"><Link href="/account/returns" className="hover:text-brand-700">← Back to returns</Link></nav>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">{r.type} request</h1>
      <p className="text-sm text-slate-600">From order <Link href={`/orders/${r.orderId}`} className="font-mono text-brand-700 hover:underline">{r.order.orderNumber}</Link></p>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">Status: <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700">{r.status.replace(/_/g, ' ')}</span></p>
          {r.refundAmountPaise != null && <p className="text-sm font-semibold text-emerald-700">Refund: {rupees(r.refundAmountPaise)}</p>}
        </div>
        <p className="mt-3 text-sm"><span className="font-semibold">Reason:</span> {r.reason}</p>
        {r.details && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{r.details}</p>}
        {r.adminNote && <p className="mt-2 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900"><strong>Admin note:</strong> {r.adminNote}</p>}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Items</p>
        <ul className="mt-2 divide-y divide-slate-100">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between py-2 text-sm">
              <span>{it.productName}{it.variantName ? ' · ' + it.variantName : ''} × {it.quantity}</span>
              <span className="font-semibold">{rupees(it.unitPricePaise * it.quantity)}</span>
            </li>
          ))}
        </ul>
      </div>

      {imgs.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase text-slate-600">Photos</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {imgs.map((u, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={i} href={u} target="_blank" rel="noopener noreferrer"><img src={u} alt="proof" className="h-24 w-24 rounded-md border border-slate-200 object-cover" /></a>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
