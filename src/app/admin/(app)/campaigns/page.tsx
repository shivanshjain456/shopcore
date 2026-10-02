'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Campaign { id: string; subject: string; audience: string; recipientCount: number | null; sentAt: string | null; createdAt: string; }

export default function CampaignsAdmin() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_campaigns', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Campaign[]; pagination: PaginationMeta }>(`/api/admin/campaigns?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const f = new FormData(e.currentTarget);
    const r = await api<{ campaign: Campaign; sent: number; recipients: number; errorsSample: string[] }>('/api/admin/campaigns', { method: 'POST', body: {
      subject: String(f.get('subject') ?? ''),
      bodyHtml: String(f.get('bodyHtml') ?? ''),
      audience: String(f.get('audience') ?? 'ALL'),
      sendNow: f.get('sendNow') === 'on',
    } });
    setBusy(false);
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg(`Saved · sent ${r.data?.sent}/${r.data?.recipients}${r.data?.errorsSample.length ? ` · errors: ${r.data.errorsSample.join('; ')}` : ''}`);
    await load();
  }

  return (
    <>
      <PageHeader title="Email campaigns" subtitle="Send via Gmail SMTP (or Brevo). Free tier: ≤500/day." />
      <Card>
        {msg && <p className="mb-2 rounded bg-emerald-50 p-2 text-sm text-emerald-800">{msg}</p>}
        <form onSubmit={send} className="grid gap-3 md:grid-cols-2">
          <label className="text-xs md:col-span-2">Subject <input name="subject" required className="i mt-1" /></label>
          <label className="text-xs md:col-span-2">HTML body <textarea name="bodyHtml" rows={8} required className="i mt-1 font-mono" placeholder="<p>Hi!</p>" /></label>
          <label className="text-xs">Audience
            <select name="audience" className="i mt-1 bg-white">
              <option value="ALL">All active users</option>
              <option value="B2C">B2C customers</option>
              <option value="B2B">B2B accounts</option>
            </select>
          </label>
          <label className="text-sm md:col-span-1 md:self-end"><input name="sendNow" type="checkbox" defaultChecked /> Send immediately</label>
          <div className="md:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button></div>
        </form>
      </Card>

      <Card className="mt-3 overflow-x-auto p-0">
        <h2 className="p-3 text-sm font-bold uppercase text-slate-700">Recent</h2>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Subject</th><th className="px-3 py-2 text-left">Audience</th><th className="px-3 py-2 text-right">Recipients</th><th className="px-3 py-2 text-left">Sent at</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">{c.subject}</td>
                <td className="px-3 py-2 text-xs">{c.audience}</td>
                <td className="px-3 py-2 text-right text-xs">{c.recipientCount ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{c.sentAt ? new Date(c.sentAt).toLocaleString('en-IN') : '—'}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">No campaigns.</td></tr>}
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
