'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

interface OrderItem { id: string; productName: string; variantName: string | null; quantity: number; unitPricePaise: number }
interface OrderResp { order: { id: string; orderNumber: string; status: string; items: OrderItem[] } }
interface Eligibility { eligibility: { eligible: boolean; reason?: string; windowEndsAt?: string } }

function NewReturnInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const orderId = sp.get('orderId') ?? '';
  const [order, setOrder] = useState<OrderResp['order'] | null>(null);
  const [elig, setElig] = useState<Eligibility['eligibility'] | null>(null);
  const [type, setType] = useState<'RETURN' | 'EXCHANGE' | 'REFUND_ONLY'>('RETURN');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useDialog();

  useEffect(() => {
    if (!orderId) return;
    (async () => {
      const [o, e] = await Promise.all([
        api<OrderResp>(`/api/orders/${orderId}`),
        api<Eligibility>(`/api/account/returns?orderId=${encodeURIComponent(orderId)}`),
      ]);
      if (o.status === 401) { window.location.href = `/login?next=/account/returns/new?orderId=${orderId}`; return; }
      if (!o.ok) { setErr(o.error ?? 'Order not found.'); return; }
      setOrder(o.data!.order); setElig(e.data?.eligibility ?? null);
    })();
  }, [orderId]);

  function setQty(itemId: string, q: number, max: number) {
    setPicks((p) => ({ ...p, [itemId]: Math.max(0, Math.min(max, q)) }));
  }

  async function uploadImage(f: File) {
    const csrf = document.cookie.match(/(?:^|; )sc_csrf=([^;]*)/)?.[1];
    const fd = new FormData(); fd.append('file', f);
    const res = await fetch('/api/account/upload?kind=return', { method: 'POST', body: fd, credentials: 'same-origin', headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {} });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) { await dialog.alert({ title: 'Upload failed', message: j.error ?? 'Please try again.' }); return; }
    setImages((i) => [...i, (j as { data: { url: string } }).data.url]);
  }

  async function submit() {
    setErr(null);
    const items = Object.entries(picks).filter(([, q]) => q > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (items.length === 0) { setErr('Pick at least one item.'); return; }
    if (reason.trim().length < 2) { setErr('Please enter a reason.'); return; }
    setBusy(true);
    const r = await api<{ id: string }>('/api/account/returns', {
      method: 'POST', body: { orderId, type, reason: reason.trim(), details: details.trim() || null, items, imageUrls: images },
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not submit.'); return; }
    router.push(`/account/returns/${r.data!.id}`);
  }

  if (!orderId) return <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">Missing order id.</p>;
  if (err && !order) return <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">{err}</p>;
  if (!order) return <p className="text-sm text-slate-500">Loading…</p>;
  if (elig && !elig.eligible) return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="font-semibold text-amber-900">Not eligible</p>
      <p className="text-sm text-amber-800">{elig.reason}</p>
    </div>
  );

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">New return / exchange</h1>
      <p className="text-sm text-slate-600">Order <span className="font-mono">{order.orderNumber}</span></p>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Type</p>
        <div className="mt-2 flex gap-2">
          {(['RETURN', 'EXCHANGE', 'REFUND_ONLY'] as const).map((t) => (
            <button key={t} onClick={() => setType(t)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${type === t ? 'border-brand-600 bg-brand-50 text-brand-900' : 'border-slate-300 hover:bg-slate-50'}`}>
              {t.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Items</p>
        <ul className="mt-2 divide-y divide-slate-100">
          {order.items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-semibold">{it.productName}{it.variantName ? ' · ' + it.variantName : ''}</p>
                <p className="text-xs text-slate-500">Bought {it.quantity} × ₹{it.unitPricePaise / 100}</p>
              </div>
              <input type="number" min={0} max={it.quantity} value={picks[it.id] ?? 0}
                     onChange={(e) => setQty(it.id, Number(e.target.value || 0), it.quantity)}
                     className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm" />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Reason</p>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Damaged on arrival"
               className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <p className="mt-3 text-xs font-semibold uppercase text-slate-600">Details (optional)</p>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <p className="mt-3 text-xs font-semibold uppercase text-slate-600">Photos (required for returns)</p>
        <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }}
               className="mt-1 block text-xs file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800" />
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u} src={u} alt="proof" className="h-20 w-20 rounded-md border border-slate-200 object-cover" />
            ))}
          </div>
        )}
      </div>

      {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      <button onClick={submit} disabled={busy}
              className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
        {busy ? 'Submitting…' : 'Submit request'}
      </button>
    </>
  );
}

export default function NewReturnPage() {
  return <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}><NewReturnInner /></Suspense>;
}
