'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';

interface RowResult { sku: string; qty: number; ok: boolean; reason?: string; productName?: string; addedQty?: number }

export default function BulkOrderPage() {
  const [text, setText] = useState('sku,qty\nACC-LOG-MX3S-301,10\nACC-LOG-MX-KEYS-302,5');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; added: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null); setBusy(true); setResults(null); setSummary(null);
    const r = await api<{ summary: typeof summary; results: RowResult[] }>('/api/b2b/bulk-add', { method: 'POST', body: { csv: text } });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) { window.location.href = '/login?next=/b2b/bulk'; return; }
      if (r.status === 403) { window.location.href = '/b2b/apply'; return; }
      setErr(r.error ?? 'Could not process.'); return;
    }
    setResults(r.data!.results); setSummary(r.data!.summary);
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Bulk order</h1>
      <p className="text-sm text-slate-600">Paste a CSV of <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">sku,qty</code> rows (or use the tabbed format). We&apos;ll resolve SKUs to products/variants and add up to 500 lines to your cart in one go.</p>

      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
                className="mt-4 w-full rounded-xl border border-slate-300 bg-white p-3 font-mono text-sm" />
      <div className="mt-3 flex items-center gap-2">
        <button disabled={busy} onClick={submit} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add to cart'}
        </button>
        {summary && <p className="text-sm text-slate-700"><strong>{summary.added}</strong> added · <strong>{summary.failed}</strong> failed (of {summary.total})</p>}
        {results && summary && summary.added > 0 && <Link href="/cart" className="text-sm font-semibold text-brand-700 hover:underline">→ View cart</Link>}
      </div>
      {err && <p className="mt-2 text-sm text-red-700">{err}</p>}

      {results && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase">
              <tr>
                <th className="p-2 text-left">SKU</th>
                <th className="p-2 text-left">Product</th>
                <th className="p-2 text-right">Asked</th>
                <th className="p-2 text-right">Added</th>
                <th className="p-2 text-left">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {results.map((r, i) => (
                <tr key={i} className={r.ok ? '' : 'bg-red-50'}>
                  <td className="p-2 font-mono text-xs">{r.sku}</td>
                  <td className="p-2">{r.productName ?? '—'}</td>
                  <td className="p-2 text-right">{r.qty}</td>
                  <td className="p-2 text-right">{r.addedQty ?? 0}</td>
                  <td className="p-2">{r.ok ? <span className="text-emerald-700">✓ Added</span> : <span className="text-red-700">✗ {r.reason}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
