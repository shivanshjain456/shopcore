'use client';

import { useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, StatusBadge } from '@/components/admin/Helpers';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Q {
  id: string; status: string; createdAt: string; updatedAt: string; lineCount: number;
  user: { email: string; firstName: string; lastName: string; companyName: string | null; gstin: string | null };
  quote: { quotedTotalPaise: number; discountPaise: number } | null;
}

export default function QuotesAdmin() {
  const [items, setItems] = useState<Q[]>([]);
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_quotes', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const load = async () => {
    const qs = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Q[]; pagination: PaginationMeta }>(`/api/admin/quotes?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, page, pageSize]);
  useEffect(() => { setPage(1); }, [status]);

  return (
    <>
      <PageHeader title="Quote requests" subtitle="Answer B2B quote requests." />
      <Card>
        <div className="flex gap-2">
          {['OPEN','QUOTED','ACCEPTED','DECLINED'].map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={`rounded-md px-3 py-1 text-xs font-semibold ${status === s ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>{s}</button>
          ))}
        </div>
      </Card>
      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Customer</th><th className="px-3 py-2 text-left">Lines</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-right">Quoted</th><th className="px-3 py-2 text-left">When</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((q) => (
              <tr key={q.id}>
                <td className="px-3 py-2 text-xs"><Link href={`/admin/quotes/${q.id}`} className="text-brand-700 hover:underline font-semibold">{q.user.companyName ?? `${q.user.firstName} ${q.user.lastName}`}</Link><br/><span className="text-slate-500">{q.user.email}</span></td>
                <td className="px-3 py-2 text-xs">{q.lineCount}</td>
                <td className="px-3 py-2"><StatusBadge s={q.status} /></td>
                <td className="px-3 py-2 text-right text-xs">{q.quote ? rupees(q.quote.quotedTotalPaise) : '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{new Date(q.updatedAt).toLocaleString('en-IN')}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">No quotes.</td></tr>}
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
