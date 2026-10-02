'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Ticket { id: string; subject: string; category: string; status: string; createdAt: string; updatedAt: string; messageCount: number }

export default function SupportPage() {
  const [list, setList] = useState<Ticket[] | null>(null);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Item 12 — offset pagination via the standard envelope.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);

  const load = async () => {
    const qs = new URLSearchParams({ page: String(page) });
    const r = await api<{ items: Ticket[]; pagination: PaginationMeta }>(`/api/account/tickets?${qs.toString()}`);
    if (r.status === 401) { window.location.href = '/login?next=/account/support'; return; }
    setList(r.data?.items ?? []);
    setPagination(r.data?.pagination ?? null);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setErr(null);
    const f = new FormData(e.currentTarget);
    const r = await api<{ id: string }>('/api/account/tickets', {
      method: 'POST', body: {
        subject: String(f.get('subject') ?? ''),
        category: String(f.get('category') ?? 'OTHER'),
        orderId: String(f.get('orderId') ?? '') || null,
        body: String(f.get('body') ?? ''),
      },
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not create.'); return; }
    setShow(false); await load();
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Support tickets</h1>
        <button onClick={() => setShow((s) => !s)} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">{show ? 'Close' : '+ New ticket'}</button>
      </div>

      {show && (
        <form onSubmit={create} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          {err && <p className="text-sm text-red-700">{err}</p>}
          <input name="subject" required placeholder="Subject" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <select name="category" required className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="ORDER">Order issue</option>
              <option value="PAYMENT">Payment</option>
              <option value="RETURN">Return / refund</option>
              <option value="TECH">Technical / product</option>
              <option value="OTHER">Other</option>
            </select>
            <input name="orderId" placeholder="Order ID (optional)" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <textarea name="body" required rows={5} placeholder="Describe your issue…" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? 'Creating…' : 'Create ticket'}</button>
        </form>
      )}

      <ul className="mt-4 space-y-2">
        {list?.map((t) => (
          <li key={t.id}>
            <Link href={`/account/support/${t.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-300">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold">{t.subject}</p>
                  <p className="text-xs text-slate-500">{t.category} · updated {new Date(t.updatedAt).toLocaleString('en-IN')}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase text-slate-700">{t.status.replace(/_/g, ' ')}</span>
              </div>
            </Link>
          </li>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No tickets yet.</p>}
      </ul>
      {pagination && (
        <Pagination
          currentPage={pagination.page}
          totalPages={pagination.totalPages}
          pageSize={pagination.pageSize}
          totalItems={pagination.total}
          onPageChange={(p) => setPage(p)}
        />
      )}
    </>
  );
}
