'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Push { id: string; title: string; body: string; audience: string; sentAt: string | null; createdAt: string; }

export default function PushAdmin() {
  const [items, setItems] = useState<Push[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_push', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();
  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Push[]; pagination: PaginationMeta }>(`/api/admin/push?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Capture the form synchronously — React 18 nulls `e.currentTarget`
    // after the first await, so calling .reset() on it later throws
    // "Cannot read properties of null".
    const form = e.currentTarget;
    const f = new FormData(form);
    const r = await api('/api/admin/push', { method: 'POST', body: {
      title: String(f.get('title') ?? ''),
      body:  String(f.get('body') ?? ''),
      audience: String(f.get('audience') ?? 'ALL'),
    } });
    if (!r.ok) { await dialog.alert({ title: 'Push notification failed', message: r.error ?? 'Please try again.' }); return; }
    form.reset(); await load();
  }
  return (
    <>
      <PageHeader title="Push notifications" subtitle="Queued and timestamped. Browser push delivery is a Phase-9 add-on." />
      <Card>
        <form onSubmit={send} className="grid gap-3 md:grid-cols-2">
          <label className="text-xs">Title <input name="title" required className="i mt-1" /></label>
          <label className="text-xs">Audience
            <select name="audience" className="i mt-1 bg-white">
              <option value="ALL">All</option><option value="B2C">B2C</option><option value="B2B">B2B</option>
            </select>
          </label>
          <label className="text-xs md:col-span-2">Body <textarea name="body" rows={3} required className="i mt-1" /></label>
          <div><Button type="submit">Send</Button></div>
        </form>
      </Card>
      <Card className="mt-3 overflow-x-auto p-0">
        <h2 className="p-3 text-sm font-bold uppercase text-slate-700">History</h2>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Title</th><th className="px-3 py-2 text-left">Audience</th><th className="px-3 py-2 text-left">When</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((p) => (<tr key={p.id}><td className="px-3 py-2">{p.title}<br/><span className="text-xs text-slate-500">{p.body}</span></td><td className="px-3 py-2 text-xs">{p.audience}</td><td className="px-3 py-2 text-xs">{p.sentAt ? new Date(p.sentAt).toLocaleString('en-IN') : '—'}</td></tr>))}
            {items.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-slate-500">None.</td></tr>}
          </tbody>
        </table>
      </Card>
      {pagination && (
        <Pagination
          currentPage={pagination.page}
          totalPages={pagination.totalPages}
          pageSize={pagination.pageSize}
          totalItems={pagination.total}
          onPageChange={(p) => setPage(p)}
          showPageSizeSelector
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          jumpInputThreshold={10}
          keyboardNav
        />
      )}
      <style jsx global>{`.i { display:block; width:100%; border:1px solid rgb(203 213 225); border-radius:0.375rem; padding:0.4rem 0.625rem; font-size:0.875rem; }`}</style>
    </>
  );
}
