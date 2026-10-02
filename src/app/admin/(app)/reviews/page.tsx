'use client';

import { useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Review {
  id: string; rating: number; title: string | null; body: string | null;
  isApproved: boolean; createdAt: string;
  product: { name: string; slug: string };
  user: { email: string; firstName: string; lastName: string };
}

export default function ReviewsAdmin() {
  const [items, setItems] = useState<Review[]>([]);
  const [filter, setFilter] = useState<'0' | '1' | ''>('0');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_reviews', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const qs = new URLSearchParams({ approved: filter, page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Review[]; pagination: PaginationMeta }>(`/api/admin/reviews?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, page, pageSize]);
  useEffect(() => { setPage(1); }, [filter]);

  async function setApproved(id: string, v: boolean) {
    const r = await api(`/api/admin/reviews/${id}`, { method: 'PATCH', body: { isApproved: v } });
    if (!r.ok) { await dialog.alert({ title: 'Could not update review', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }
  async function del(id: string) {
    const ok = await dialog.confirm({
      title: 'Delete review?',
      message: 'This review will be permanently removed.',
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    const r = await api(`/api/admin/reviews/${id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Could not delete review', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  return (
    <>
      <PageHeader title="Reviews" subtitle="Moderate customer reviews." />
      <Card>
        <div className="flex gap-2">
          <button onClick={() => setFilter('0')} className={`rounded-md px-3 py-1 text-xs font-semibold ${filter === '0' ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>Pending</button>
          <button onClick={() => setFilter('1')} className={`rounded-md px-3 py-1 text-xs font-semibold ${filter === '1' ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>Approved</button>
          <button onClick={() => setFilter('')}  className={`rounded-md px-3 py-1 text-xs font-semibold ${filter === ''  ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>All</button>
        </div>
      </Card>
      <Card className="mt-3 divide-y divide-slate-100 p-0">
        {items.map((r) => (
          <div key={r.id} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <Link href={`/p/${r.product.slug}`} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand-700 hover:underline">{r.product.name}</Link>
                <p className="text-xs text-slate-500">by {r.user.firstName} {r.user.lastName} · {new Date(r.createdAt).toLocaleString('en-IN')}</p>
                <p className="text-amber-500">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</p>
                {r.title && <p className="font-semibold">{r.title}</p>}
                {r.body && <p className="text-sm text-slate-700">{r.body}</p>}
              </div>
              <div className="flex flex-col gap-1">
                <StatusBadge s={r.isApproved ? 'APPROVED' : 'PENDING'} />
                {!r.isApproved && <Button tone="primary" onClick={() => setApproved(r.id, true)}>Approve</Button>}
                {r.isApproved && <Button tone="ghost" onClick={() => setApproved(r.id, false)}>Unapprove</Button>}
                <Button tone="danger" onClick={() => del(r.id)}>Delete</Button>
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No reviews.</p>}
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
