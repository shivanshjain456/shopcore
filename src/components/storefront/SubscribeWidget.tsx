'use client';
/**
 * Subscribe to recurring orders of this product. Auth-required; the popover
 * collapses gracefully for guests with a "sign in to subscribe" prompt.
 */
import { useState } from 'react';
import { api } from '@/lib/client/api';

interface VariantLite { id: string; name: string }

export default function SubscribeWidget({ productId, variants }: { productId: string; variants: VariantLite[] }) {
  const [open, setOpen] = useState(false);
  const [variantId, setVariantId] = useState<string | null>(variants[0]?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [intervalDays, setIntervalDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit() {
    setBusy(true); setMsg(null);
    const r = await api('/api/account/subscriptions', {
      method: 'POST',
      body: {
        productId,
        variantId: variants.length > 0 ? variantId : null,
        quantity, intervalDays,
      },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname); return; }
      setMsg({ kind: 'err', text: r.error ?? 'Could not subscribe.' });
      return;
    }
    setMsg({ kind: 'ok', text: 'Subscribed! See My account → Subscriptions.' });
    setTimeout(() => { setOpen(false); setMsg(null); }, 2000);
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((s) => !s)}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
        🔁 Subscribe
      </button>

      {open && (
        <div className="absolute z-10 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <p className="text-xs font-semibold uppercase text-slate-600">Recurring order</p>
          {variants.length > 0 && (
            <label className="mt-2 block text-xs">
              Variant
              <select value={variantId ?? ''} onChange={(e) => setVariantId(e.target.value)}
                      className="mt-0.5 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
                {variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block text-xs">
              Quantity
              <input type="number" min={1} max={10} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.min(10, Number(e.target.value || 1))))}
                     className="mt-0.5 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block text-xs">
              Every (days)
              <select value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))}
                      className="mt-0.5 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
                <option value={7}>7</option>
                <option value={14}>14</option>
                <option value={30}>30</option>
                <option value={45}>45</option>
                <option value={60}>60</option>
                <option value={90}>90</option>
                <option value={180}>180</option>
              </select>
            </label>
          </div>
          {msg && <p className={`mt-2 text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={submit} disabled={busy} className="flex-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? 'Saving…' : 'Subscribe'}
            </button>
            <button onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Manage / pause / cancel any time from your account.
          </p>
        </div>
      )}
    </div>
  );
}
