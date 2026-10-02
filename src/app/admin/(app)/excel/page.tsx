'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';

export default function ExcelPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function upload(endpoint: string, file: File, extraForm?: Record<string, string>) {
    setBusy(true); setErr(null); setResult(null);
    try {
      const csrf = document.cookie.match(/(?:^|; )sc_csrf=([^;]*)/)?.[1];
      const fd = new FormData(); fd.append('file', file);
      if (extraForm) for (const [k, v] of Object.entries(extraForm)) fd.append(k, v);
      const res = await fetch(endpoint, { method: 'POST', body: fd, credentials: 'same-origin', headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {} });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? 'Upload failed.'); return; }
      setResult(j.data);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Excel import / export" subtitle="Bulk operations against the catalogue, inventory and users." />

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <h2 className="text-sm font-bold uppercase text-slate-700">Products</h2>
          <p className="mt-1 text-xs text-slate-600">Export → edit → re-upload. Variants live on a 2nd sheet.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/api/admin/excel/products/export" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Download products.xlsx</a>
            <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">
              Upload .xlsx
              <input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload('/api/admin/excel/products/import', f); }} />
            </label>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-bold uppercase text-slate-700">Inventory</h2>
          <p className="mt-1 text-xs text-slate-600">Header: <code>sku, stock</code> (absolute) or <code>sku, delta</code>.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="cursor-pointer rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
              Upload absolute stock
              <input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload('/api/admin/excel/inventory/import', f, { mode: 'absolute' }); }} />
            </label>
            <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">
              Upload deltas (+/-)
              <input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload('/api/admin/excel/inventory/import', f, { mode: 'delta' }); }} />
            </label>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-bold uppercase text-slate-700">Users</h2>
          <p className="mt-1 text-xs text-slate-600">One-click full backup of every customer with every field.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/api/admin/excel/users/export?format=xlsx" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Download users.xlsx</a>
            <a href="/api/admin/excel/users/export?format=csv"  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Download users.csv</a>
          </div>
        </Card>
      </div>

      {busy && <p className="mt-3 text-sm text-slate-500">Uploading…</p>}
      {err && <p className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      {result != null && (
        <Card className="mt-3">
          <h3 className="text-sm font-bold uppercase text-slate-700">Result</h3>
          <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-50 p-2 text-[11px]">{JSON.stringify(result, null, 2)}</pre>
        </Card>
      )}
    </>
  );
}
