'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Sub {
  id: string; productId: string; variantId: string | null; quantity: number; intervalDays: number;
  nextOrderAt: string; isActive: boolean;
  product: { id: string; name: string; slug: string; imageUrl: string | null } | null;
}

export default function SubscriptionsPage() {
  const [list, setList] = useState<Sub[] | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ subscriptions: Sub[] }>('/api/account/subscriptions');
    if (r.status === 401) { window.location.href = '/login?next=/account/subscriptions'; return; }
    setList(r.data?.subscriptions ?? []);
  };
  useEffect(() => { void load(); }, []);

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await api(`/api/account/subscriptions/${id}`, { method: 'PATCH', body });
    if (!r.ok) { await dialog.alert({ title: 'Could not update', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }
  async function del(id: string) {
    const ok = await dialog.confirm({
      title: 'Cancel subscription?',
      message: 'No further auto-orders will be placed. You can re-subscribe anytime.',
      intent: 'destructive', confirmLabel: 'Cancel subscription', cancelLabel: 'Keep it',
    });
    if (!ok) return;
    const r = await api(`/api/account/subscriptions/${id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Could not cancel', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Subscriptions</h1>
      <p className="text-sm text-slate-600">Recurring orders for things you buy regularly.</p>
      <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        To start a subscription, open any product from <Link href="/" className="font-semibold text-brand-700 hover:underline">the catalogue</Link> and use the &quot;Subscribe&quot; option (coming alongside Phase 6).
      </p>

      <ul className="mt-4 space-y-2">
        {list?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
            {s.product?.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.product.imageUrl} alt={s.product.name} className="h-14 w-20 rounded object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{s.product?.name ?? 'Product'}</p>
              <p className="text-xs text-slate-500">Every {s.intervalDays} days · Qty {s.quantity} · Next: {new Date(s.nextOrderAt).toLocaleDateString('en-IN')}</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{s.isActive ? 'Active' : 'Paused'}</span>
            <div className="flex gap-2">
              <button onClick={() => patch(s.id, { isActive: !s.isActive })} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">{s.isActive ? 'Pause' : 'Resume'}</button>
              <button onClick={() => del(s.id)} className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50">Cancel</button>
            </div>
          </li>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No subscriptions.</p>}
      </ul>
    </>
  );
}
