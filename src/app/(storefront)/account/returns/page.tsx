'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Ret {
  id: string; orderId: string; orderNumber: string; type: string; reason: string; status: string;
  refundAmountPaise: number | null; createdAt: string; items: Array<{ productName: string; quantity: number }>;
}

export default function ReturnsPage() {
  const [list, setList] = useState<Ret[] | null>(null);
  // Item 12 — offset pagination via the standard envelope.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  useEffect(() => {
    (async () => {
      const qs = new URLSearchParams({ page: String(page) });
      const r = await api<{ items: Ret[]; pagination: PaginationMeta }>(`/api/account/returns?${qs.toString()}`);
      if (r.status === 401) { window.location.href = '/login?next=/account/returns'; return; }
      setList(r.data?.items ?? []);
      setPagination(r.data?.pagination ?? null);
    })();
  }, [page]);

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Returns &amp; exchanges</h1>
      <p className="text-sm text-slate-600">Request a return, exchange, or refund from any delivered order.</p>

      <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        To start a new request, open a delivered order from <Link href="/account/orders" className="font-semibold text-brand-700 hover:underline">My orders</Link>.
      </p>

      <ul className="mt-6 space-y-2">
        {list?.map((r) => (
          <li key={r.id}>
            <Link href={`/account/returns/${r.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-300">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">{r.type} from <span className="font-mono">{r.orderNumber}</span></p>
                  <p className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString('en-IN')} · {r.items.length} item(s) · {r.reason}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-slate-700">{r.status.replace(/_/g, ' ')}</p>
                  {r.refundAmountPaise != null && <p className="text-xs text-emerald-700">Refund: {rupees(r.refundAmountPaise)}</p>}
                </div>
              </div>
            </Link>
          </li>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No requests yet.</p>}
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
