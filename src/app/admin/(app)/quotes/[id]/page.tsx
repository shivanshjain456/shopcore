'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';

interface Line { productId: string; variantId: string | null; quantity: number; note?: string | null }
interface Q {
  id: string; status: string; note: string | null; createdAt: string;
  user: { email: string; companyName: string | null; gstin: string | null };
  lines: Line[];
  quote: { lines: { productId: string; variantId: string | null; quantity: number; unitPricePaise: number; lineTotalPaise: number }[]; subtotalPaise: number; quotedTotalPaise: number; discountPaise: number; expiresAt: string; adminNote?: string | null } | null;
}

export default function QuoteAnswerPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const [q, setQ] = useState<Q | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [days, setDays] = useState(7);
  const [adminNote, setAdminNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api<{ quote: Q }>(`/api/admin/quotes/${id}`);
    if (r.ok && r.data) setQ(r.data.quote);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!q) return;
    setBusy(true); setMsg(null);
    const lines = q.lines.map((l, i) => ({
      productId: l.productId, variantId: l.variantId ?? null,
      quantity: l.quantity, unitPricePaise: Math.round(Number(prices[i] ?? 0) * 100),
    }));
    const r = await api(`/api/admin/quotes/${id}`, { method: 'POST', body: { validForDays: days, adminNote: adminNote.trim() || null, lines } });
    setBusy(false);
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg('Counter-quote sent.'); await load();
  }

  if (!q) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <PageHeader title="Quote answer" subtitle={`From ${q.user.companyName ?? q.user.email} · ${q.user.gstin ?? ''}`} actions={<StatusBadge s={q.status} />} />
      {msg && <p className="mb-3 rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{msg}</p>}
      {q.note && <p className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-sm">Customer note: {q.note}</p>}

      <Card>
        <h2 className="text-sm font-bold uppercase text-slate-700">Set unit prices (₹)</h2>
        <form onSubmit={submit} className="mt-3 space-y-2">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">Product</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Unit ₹</th><th className="px-2 py-1 text-right">Line</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {q.lines.map((l, i) => {
                const price = Number(prices[i] ?? 0);
                return (
                  <tr key={i}>
                    <td className="px-2 py-1 font-mono text-xs">{l.productId}{l.variantId ? ' · ' + l.variantId : ''}</td>
                    <td className="px-2 py-1 text-right">{l.quantity}</td>
                    <td className="px-2 py-1 text-right"><input type="number" min={0} step={0.01} value={prices[i] ?? ''} onChange={(e) => setPrices({ ...prices, [i]: e.target.value })} className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></td>
                    <td className="px-2 py-1 text-right font-semibold">₹{(price * l.quantity).toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="text-sm">Valid for (days) <input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" /></label>
            <label className="text-sm">Admin note (optional) <input value={adminNote} onChange={(e) => setAdminNote(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          </div>
          {q.status === 'OPEN' && <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send counter-quote'}</Button>}
        </form>
      </Card>

      {q.quote && (
        <Card className="mt-3">
          <h2 className="text-sm font-bold uppercase text-slate-700">Current counter-quote</h2>
          <p className="text-sm">Subtotal {rupees(q.quote.subtotalPaise)} → quoted {rupees(q.quote.quotedTotalPaise)} (save {rupees(q.quote.discountPaise)})</p>
          <p className="text-xs text-slate-500">Valid until {new Date(q.quote.expiresAt).toLocaleString('en-IN')}</p>
          {q.quote.adminNote && <p className="mt-1 text-sm">Note: {q.quote.adminNote}</p>}
        </Card>
      )}
    </>
  );
}
