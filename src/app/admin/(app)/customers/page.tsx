'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { formatPhone } from '@/lib/utils/phone';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Row {
  id: string; firstName: string; lastName: string; email: string; phone: string;
  role: string; status: string; loyaltyPoints: number; createdAt: string;
  companyName: string | null; gstin: string | null;
  b2bTier: { name: string } | null;
  _count: { orders: number; reviews: number };
}

function CustomersPageInner() {
  const sp = useSearchParams();
  const [items, setItems] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [role, setRole] = useState(sp.get('role') ?? '');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  // Item 12 — full pagination meta from the new envelope. `page` is
  //   URL-driven via Phase-2 urlSync — the browser back button + bookmarks
  //   Just Work.
  const [page, setPage] = useState(() => {
    const v = sp.get('page');
    return v && /^\d+$/.test(v) ? Math.max(1, Number(v)) : 1;
  });
  const [pageSize, setPageSize] = usePageSizePreference('admin_customers', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);

  // Sync local `page` <- URL when the user uses the browser back/forward.
  useEffect(() => {
    const v = sp.get('page');
    const n = v && /^\d+$/.test(v) ? Math.max(1, Number(v)) : 1;
    setPage(n);
  }, [sp]);

  const load = async () => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q); if (role) qs.set('role', role); if (status) qs.set('status', status);
    qs.set('page', String(page)); qs.set('pageSize', String(pageSize));
    const r = await api<{ items: Row[]; pagination: PaginationMeta }>(`/api/admin/customers?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [role, status, page, pageSize]);

  const total = pagination?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Customers" subtitle={`${total} user${total === 1 ? '' : 's'}`}
        actions={<>
          <a href="/api/admin/excel/users/export?format=xlsx" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Export XLSX</a>
          <a href="/api/admin/excel/users/export?format=csv"  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Export CSV</a>
        </>}
      />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void load(); }} className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, phone, GSTIN…" className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All roles</option>
            {['CUSTOMER', 'B2B', 'ADMIN'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All status</option>
            {['ACTIVE','PENDING_OTP','SUSPENDED','DELETED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Contact</th><th className="px-3 py-2 text-left">Role / status</th><th className="px-3 py-2 text-right">Orders</th><th className="px-3 py-2 text-right">Points</th><th className="px-3 py-2 text-left">Joined</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2"><Link href={`/admin/customers/${u.id}`} className="font-semibold text-brand-700 hover:underline">{u.firstName} {u.lastName}</Link>{u.companyName && <><br/><span className="text-xs text-slate-500">{u.companyName}</span></>}</td>
                <td className="px-3 py-2 text-xs">{u.email}<br/>{formatPhone(u.phone)}{u.gstin && <><br/><code className="font-mono text-[10px]">{u.gstin}</code></>}</td>
                <td className="px-3 py-2 space-x-1"><StatusBadge s={u.role} />{u.b2bTier && <StatusBadge s={u.b2bTier.name} />}<br/><StatusBadge s={u.status} /></td>
                <td className="px-3 py-2 text-right">{u._count.orders}</td>
                <td className="px-3 py-2 text-right">{u.loyaltyPoints}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{new Date(u.createdAt).toLocaleDateString('en-IN')}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No customers.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Item 12 — pagination controls. Component returns null when
          totalPages <= 1 so we don't need to guard here. */}
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
          urlSync
        />
      )}
    </>
  );
}

// Suspense boundary required by useSearchParams in Next 14.
export default function CustomersPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <CustomersPageInner />
    </Suspense>
  );
}
