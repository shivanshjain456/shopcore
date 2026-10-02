'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, StatusBadge, Button } from '@/components/admin/Helpers';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Row {
  id: string; orderNumber: string; status: string; paymentStatus: string; totalPaise: number;
  createdAt: string; courierName: string | null;
  user: { email: string; firstName: string; lastName: string; companyName: string | null };
  _count: { items: number };
}

function OrdersListInner() {
  const sp = useSearchParams();
  const [items, setItems] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [paymentStatus, setPaymentStatus] = useState(sp.get('paymentStatus') ?? '');
  // Item 12 — full pagination meta from the new envelope.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_orders', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);

  const load = async () => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (status) qs.set('status', status);
    if (paymentStatus) qs.set('paymentStatus', paymentStatus);
    qs.set('page', String(page)); qs.set('pageSize', String(pageSize));
    const r = await api<{ items: Row[]; pagination: PaginationMeta }>(`/api/admin/orders?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, paymentStatus, page, pageSize]);

  const total = pagination?.total ?? 0;

  return (
    <>
      <PageHeader title="Orders" subtitle={`${total} order${total === 1 ? '' : 's'} match filters`} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void load(); }} className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, email, UTR…" className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All status</option>
            {['PENDING_PAYMENT_REVIEW','PAYMENT_VERIFIED','PAYMENT_REJECTED','PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','RETURNED','REFUNDED'].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All payments</option>
            {['AWAITING_VERIFICATION','VERIFIED','REJECTED','REFUNDED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase">
            <tr><th className="px-3 py-2 text-left">Order #</th><th className="px-3 py-2 text-left">Customer</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Payment</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-left">When</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2"><Link href={`/admin/orders/${o.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{o.orderNumber}</Link></td>
                <td className="px-3 py-2 text-xs">{o.user.companyName ? <strong>{o.user.companyName}</strong> : `${o.user.firstName} ${o.user.lastName}`}<br/><span className="text-slate-500">{o.user.email}</span></td>
                <td className="px-3 py-2"><StatusBadge s={o.status} /></td>
                <td className="px-3 py-2"><StatusBadge s={o.paymentStatus} /></td>
                <td className="px-3 py-2 text-right font-semibold">{rupees(o.totalPaise)}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{new Date(o.createdAt).toLocaleString('en-IN')}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No orders.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Item 12 — pagination controls. */}
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

export default function Page() {
  return <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}><OrdersListInner /></Suspense>;
}
