'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { useRouter } from 'next/navigation';
import { useDialog } from '@/components/dialog/DialogProvider';

interface SavedCart { id: string; name: string; createdAt: string; items: { productId: string; variantId: string | null; quantity: number }[] }

export default function SavedCartsPage() {
  const router = useRouter();
  const [list, setList] = useState<SavedCart[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ savedCarts: SavedCart[] }>('/api/account/saved-carts');
    if (r.status === 401) { window.location.href = '/login?next=/account/saved-carts'; return; }
    setList(r.data?.savedCarts ?? []);
  };
  useEffect(() => { void load(); }, []);

  async function snap(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setErr(null); setBusy(true);
    const r = await api('/api/account/saved-carts', { method: 'POST', body: { name: name.trim() } });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not save.'); return; }
    setName(''); await load();
  }
  async function restore(id: string) {
    const r = await api(`/api/account/saved-carts/${id}`, { method: 'POST' });
    if (!r.ok) { await dialog.alert({ title: 'Could not restore', message: r.error ?? 'Please try again.' }); return; }
    router.push('/cart');
  }
  async function del(id: string) {
    const ok = await dialog.confirm({
      title: 'Delete saved cart?', message: 'This cannot be undone.',
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    const r = await api(`/api/account/saved-carts/${id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Could not delete', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Saved carts</h1>
      <p className="text-sm text-slate-600">Snapshot your current cart and restore it later.</p>

      <form onSubmit={snap} className="mt-4 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this snapshot (e.g. Office setup)"
               className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <button disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Saving…' : 'Snapshot current cart'}
        </button>
      </form>
      {err && <p className="mt-2 text-sm text-red-700">{err}</p>}

      <ul className="mt-6 space-y-2">
        {list?.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4">
            <div>
              <p className="font-semibold">{s.name}</p>
              <p className="text-xs text-slate-500">{new Date(s.createdAt).toLocaleString('en-IN')} · {s.items.reduce((a, b) => a + b.quantity, 0)} item(s)</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => restore(s.id)} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Restore</button>
              <button onClick={() => del(s.id)} className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">Delete</button>
            </div>
          </li>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No saved carts yet.</p>}
      </ul>
    </>
  );
}
