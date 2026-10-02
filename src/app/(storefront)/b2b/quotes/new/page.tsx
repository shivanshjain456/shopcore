'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';

interface ProductRow {
  id: string; slug: string; name: string; pricePaise: number;
  imageUrl?: string | null;
  hasVariants: boolean;
}
interface Variant { id: string; name: string; pricePaise: number; stock: number }
interface ProductDetail { id: string; name: string; variants: Variant[] }

interface DraftLine {
  /** Stable client-side id — survives reorder / remove so React can
   *  reconcile correctly. Synthesised at line creation time so two
   *  lines with the same product+variant don't collide. */
  uid: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
}

/** Cheap unique id; not security-critical, never sent to the server. */
function newDraftUid(): string {
  return `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function NewQuotePage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ProductRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setResults([]); return; }
      setSearching(true);
      const r = await api<{ items: ProductRow[] }>(`/api/products?q=${encodeURIComponent(q.trim())}&pageSize=6`);
      setSearching(false);
      if (r.ok && r.data) setResults(r.data.items);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function pick(p: ProductRow) {
    if (p.hasVariants) {
      const d = await api<ProductDetail>(`/api/products/${p.slug}`);
      if (!d.ok || !d.data) return;
      const v = d.data.variants[0];
      setLines((ls) => [...ls, { uid: newDraftUid(), productId: p.id, productName: p.name, variantId: v?.id ?? null, variantName: v?.name ?? null, quantity: 1 }]);
    } else {
      setLines((ls) => [...ls, { uid: newDraftUid(), productId: p.id, productName: p.name, variantId: null, variantName: null, quantity: 1 }]);
    }
    setQ(''); setResults([]);
  }

  // Update / remove by stable uid (NOT array index). Index-based
  // mutation breaks React reconciliation when an earlier line is
  // removed — the new item at that index inherits the previous one's
  // input focus + entered quantity.
  function setQty(uid: string, n: number) {
    setLines((ls) => ls.map((l) => l.uid === uid ? { ...l, quantity: Math.max(1, Math.min(1000, n)) } : l));
  }
  function remove(uid: string) {
    setLines((ls) => ls.filter((l) => l.uid !== uid));
  }

  const canSubmit = useMemo(() => lines.length > 0 && !busy, [lines, busy]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const r = await api<{ id: string }>('/api/b2b/quotes', {
      method: 'POST',
      body: { note: note.trim() || null, lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })) },
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not create quote.'); return; }
    router.push(`/b2b/quotes/${r.data!.id}`);
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">New quote request</h1>
      <p className="text-sm text-slate-600">Add line items and a note. Our team will respond with a counter-quote you can accept in one click.</p>

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <label className="text-xs font-semibold uppercase text-slate-600">Add product</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, brand or SKU…"
                 className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          {searching && <p className="mt-2 text-xs text-slate-500">Searching…</p>}
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => pick(p)} className="flex w-full items-center justify-between gap-3 p-2 text-left hover:bg-slate-50">
                    <span className="text-sm">{p.name}</span>
                    <span className="text-xs text-slate-500">₹{p.pricePaise / 100}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase text-slate-600">Lines</p>
          <ul className="mt-2 divide-y divide-slate-100">
            {lines.length === 0 && <li className="py-3 text-sm text-slate-500">No lines yet — search above to add.</li>}
            {lines.map((l) => (
              <li key={l.uid} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{l.productName}</p>
                  {l.variantName && <p className="text-xs text-slate-500">{l.variantName}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={1000} value={l.quantity} onChange={(e) => setQty(l.uid, Number(e.target.value || 1))}
                         className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm" />
                  <button type="button" onClick={() => remove(l.uid)} className="text-xs text-red-700 hover:underline">Remove</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <label className="text-xs font-semibold uppercase text-slate-600">Note for our team (optional)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Anything about deliverables, timelines, GST, project, etc."
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        </div>

        {err && <p className="text-sm text-red-700">{err}</p>}
        <button disabled={!canSubmit} type="submit" className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Submitting…' : 'Submit quote request'}
        </button>
      </form>
    </>
  );
}
