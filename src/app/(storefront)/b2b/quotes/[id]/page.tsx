'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Line {
  productId: string; productName: string; productSlug: string; imageUrl: string | null;
  variantId: string | null; quantity: number;
  unitPricePaise?: number; lineTotalPaise?: number;
}
interface Quote {
  id: string; status: string; note: string | null;
  createdAt: string; updatedAt: string;
  lines: Line[];
  quote: {
    subtotalPaise: number; quotedTotalPaise: number; discountPaise: number;
    expiresAt: string; adminNote?: string | null;
  } | null;
}

export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const router = useRouter();
  const [q, setQ] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ quote: Quote }>(`/api/b2b/quotes/${id}`);
    if (r.status === 401) { window.location.href = `/login?next=/b2b/quotes/${id}`; return; }
    if (!r.ok) { setMsg(r.error ?? 'Not found.'); return; }
    setQ(r.data?.quote ?? null);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function accept() {
    const ok = await dialog.confirm({
      title: 'Accept this quote?',
      message: 'The lines will be added to your cart with the quoted prices.',
      intent: 'success', confirmLabel: 'Accept quote',
    });
    if (!ok) return;
    setBusy(true);
    const r = await api<{ couponCode: string }>(`/api/b2b/quotes/${id}/accept`, { method: 'POST' });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Could not accept', message: r.error ?? 'Please try again.' }); return; }
    await dialog.alert({
      title: 'Quote accepted',
      message: `Use coupon code ${r.data!.couponCode} at checkout (it is pre-generated for you).`,
      intent: 'success',
    });
    router.push(`/checkout`);
  }
  async function decline() {
    const reason = await dialog.promptUser({
      title: 'Decline this quote?',
      message: 'Optional — tell us why so we can improve our offer.',
      placeholder: 'e.g. Found a better price elsewhere',
      multiline: true, maxLength: 500,
      confirmLabel: 'Decline quote', cancelLabel: 'Keep quote',
      intent: 'destructive',
    });
    if (reason === null) return; // user cancelled
    setBusy(true);
    const r = await api(`/api/b2b/quotes/${id}/decline`, { method: 'POST', body: { reason: reason.trim() || undefined } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Could not decline', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  if (msg && !q) return <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{msg}</p>;
  if (!q) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <nav className="text-xs text-slate-500"><Link href="/b2b/quotes" className="hover:text-brand-700">← Back to quotes</Link></nav>
      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Quote</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700">{q.status}</span>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Requested lines</p>
        <ul className="mt-2 divide-y divide-slate-100">
          {q.lines.map((l, i) => (
            <li key={i} className="flex items-center gap-3 py-2 text-sm">
              {l.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.imageUrl} alt={l.productName} className="h-12 w-16 rounded object-cover" />
              )}
              <div className="flex-1">
                <Link href={`/p/${l.productSlug}`} className="font-medium hover:text-brand-700">{l.productName}</Link>
                {l.variantId && <p className="text-xs text-slate-500">Variant: {l.variantId}</p>}
                <p className="text-xs text-slate-500">Qty: {l.quantity}</p>
              </div>
              {l.unitPricePaise != null && (
                <div className="text-right text-sm">
                  <p className="font-semibold">{rupees(l.lineTotalPaise ?? 0)}</p>
                  <p className="text-xs text-slate-500">{rupees(l.unitPricePaise)} ea</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {q.quote ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-semibold uppercase text-emerald-900">Counter-quote from our team</p>
          <p className="mt-1 text-sm text-emerald-800">Valid until {new Date(q.quote.expiresAt).toLocaleString('en-IN')}</p>
          {q.quote.adminNote && <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-800">{q.quote.adminNote}</p>}
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-emerald-800">Catalogue subtotal</dt><dd>{rupees(q.quote.subtotalPaise)}</dd></div>
            <div className="flex justify-between text-emerald-900"><dt>Quoted total</dt><dd className="font-bold">{rupees(q.quote.quotedTotalPaise)}</dd></div>
            <div className="flex justify-between text-emerald-800"><dt>You save</dt><dd>− {rupees(q.quote.discountPaise)}</dd></div>
          </dl>
          {q.status === 'QUOTED' && (
            <div className="mt-3 flex gap-2">
              <button disabled={busy} onClick={accept} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                Accept &amp; go to checkout
              </button>
              <button disabled={busy} onClick={decline} className="rounded-md border border-emerald-300 px-3 py-1.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50">
                Decline
              </button>
            </div>
          )}
          {q.status === 'ACCEPTED' && <p className="mt-2 text-xs font-semibold text-emerald-900">✓ Accepted — your one-time coupon is active until expiry.</p>}
          {q.status === 'DECLINED' && <p className="mt-2 text-xs font-semibold text-slate-600">✗ Declined.</p>}
        </div>
      ) : (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          ⏳ Waiting for our team to send a counter-quote. You will see it here when ready.
        </p>
      )}

      {q.note && (
        <p className="mt-4 rounded-md border border-slate-200 bg-white p-3 text-sm">
          <span className="text-xs font-semibold uppercase text-slate-500">Your note:</span> {q.note}
        </p>
      )}
    </>
  );
}
