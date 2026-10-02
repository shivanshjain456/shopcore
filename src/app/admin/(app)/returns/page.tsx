'use client';

import { useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, StatusBadge, Button } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Ret {
  id: string; type: string; reason: string; status: string;
  refundAmountPaise: number | null; createdAt: string;
  user: { email: string; firstName: string; lastName: string };
  order: { orderNumber: string };
}

export default function ReturnsAdmin() {
  const [items, setItems] = useState<Ret[]>([]);
  const [status, setStatus] = useState('REQUESTED');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_returns', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();
  const load = async () => {
    const qs = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Ret[]; pagination: PaginationMeta }>(`/api/admin/returns?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, page, pageSize]);
  useEffect(() => { setPage(1); }, [status]);

  async function setStatusOf(id: string, newStatus: string) {
    const r = await api(`/api/admin/returns/${id}`, { method: 'PATCH', body: { status: newStatus } });
    if (!r.ok) { await dialog.alert({ title: 'Status change failed', message: r.error ?? 'Please try again.' }); return; }
    await load();
  }

  return (
    <>
      <PageHeader title="Returns" subtitle="Approve, reject, mark received, issue refund." />
      <Card>
        <div className="flex gap-2">
          {['REQUESTED','APPROVED','ITEM_RECEIVED','REFUND_ISSUED','CLOSED','REJECTED'].map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={`rounded-md px-3 py-1 text-xs font-semibold ${status === s ? 'bg-amber-500 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>{s.replace(/_/g, ' ')}</button>
          ))}
        </div>
      </Card>
      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Order</th><th className="px-3 py-2 text-left">Customer</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2 text-left">Reason</th><th className="px-3 py-2 text-right">Refund</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Actions</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-mono text-xs"><Link href={`/admin/orders/${r.order.orderNumber}`} className="text-brand-700 hover:underline">{r.order.orderNumber}</Link></td>
                <td className="px-3 py-2 text-xs">{r.user.firstName} {r.user.lastName}<br/><span className="text-slate-500">{r.user.email}</span></td>
                <td className="px-3 py-2"><StatusBadge s={r.type} /></td>
                <td className="px-3 py-2 text-xs">{r.reason}</td>
                <td className="px-3 py-2 text-right text-xs">{r.refundAmountPaise != null ? rupees(r.refundAmountPaise) : '—'}</td>
                <td className="px-3 py-2"><StatusBadge s={r.status} /></td>
                <td className="px-3 py-2 space-x-1">
                  {r.status === 'REQUESTED' && <>
                    <Button tone="primary" onClick={() => setStatusOf(r.id, 'APPROVED')}>Approve</Button>
                    <Button tone="danger"  onClick={() => setStatusOf(r.id, 'REJECTED')}>Reject</Button>
                  </>}
                  {r.status === 'APPROVED' && <Button onClick={() => setStatusOf(r.id, 'ITEM_RECEIVED')}>Mark received</Button>}
                  {r.status === 'ITEM_RECEIVED' && <Button onClick={() => setStatusOf(r.id, 'REFUND_ISSUED')}>Mark refund issued</Button>}
                  {r.status === 'REFUND_ISSUED' && <Button onClick={() => setStatusOf(r.id, 'CLOSED')}>Close</Button>}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No items.</td></tr>}
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
