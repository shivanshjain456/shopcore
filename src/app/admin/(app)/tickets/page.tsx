'use client';

import { useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { PageHeader, Card, StatusBadge } from '@/components/admin/Helpers';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface T { id: string; subject: string; category: string; status: string; updatedAt: string; user: { email: string; firstName: string; lastName: string }; _count: { messages: number } }

export default function TicketsAdmin() {
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_tickets', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const load = async () => {
    const qs = new URLSearchParams(); if (status) qs.set('status', status);
    qs.set('page', String(page)); qs.set('pageSize', String(pageSize));
    const r = await api<{ items: T[]; pagination: PaginationMeta }>(`/api/admin/tickets?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, page, pageSize]);
  useEffect(() => { setPage(1); }, [status]);
  return (
    <>
      <PageHeader title="Support tickets" subtitle="Customer tickets across categories." />
      <Card>
        <div className="flex gap-2 text-xs">
          {['','OPEN','AWAITING_AGENT','AWAITING_CUSTOMER','RESOLVED','CLOSED'].map((s) => (
            <button key={s || 'all'} onClick={() => setStatus(s)} className={`rounded-md px-3 py-1 font-semibold ${status === s ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>{s || 'All'}</button>
          ))}
        </div>
      </Card>
      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Subject</th><th className="px-3 py-2 text-left">Customer</th><th className="px-3 py-2 text-left">Category</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-right">Msgs</th><th className="px-3 py-2 text-left">When</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2"><Link href={`/admin/tickets/${t.id}`} className="font-semibold text-brand-700 hover:underline">{t.subject}</Link></td>
                <td className="px-3 py-2 text-xs">{t.user.firstName} {t.user.lastName}<br/><span className="text-slate-500">{t.user.email}</span></td>
                <td className="px-3 py-2 text-xs">{t.category}</td>
                <td className="px-3 py-2"><StatusBadge s={t.status} /></td>
                <td className="px-3 py-2 text-right">{t._count.messages}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{new Date(t.updatedAt).toLocaleString('en-IN')}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No tickets.</td></tr>}
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
    </>
  );
}
