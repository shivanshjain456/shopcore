'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Row {
  id: string; sku: string; name: string; slug: string;
  pricePaise: number; mrpPaise: number; stock: number; lowStockAt: number;
  isActive: boolean; isFeatured: boolean;
  category: { name: string; slug: string };
  brand:    { name: string } | null;
  _count: { variants: number; orderItems: number };
}

export default function AdminProductsPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_products', 25);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);

  const load = async () => {
    // Item 12 — new pagination envelope; pageSize is now state-driven
    // (was hardcoded 25).
    const r = await api<{ items: Row[]; pagination: PaginationMeta }>(
      `/api/admin/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
    );
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  const total = pagination?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Products" subtitle={`${total} product${total === 1 ? '' : 's'} total`}
        actions={
          <>
            <Link href="/admin/excel"   className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Excel import/export</Link>
            <Link href="/admin/products/new" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">+ New product</Link>
          </>
        }
      />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); void load(); }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, SKU, brand…"
                 className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Category</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-left">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                <td className="px-3 py-2"><Link href={`/admin/products/${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.name}</Link></td>
                <td className="px-3 py-2 text-xs">{p.category.name}{p.brand && ` · ${p.brand.name}`}</td>
                <td className="px-3 py-2 text-right">{rupees(p.pricePaise)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${p.stock <= p.lowStockAt ? 'text-red-700' : ''}`}>{p.stock}</td>
                <td className="px-3 py-2 space-x-1">
                  <StatusBadge s={p.isActive ? 'ACTIVE' : 'INACTIVE'} />
                  {p.isFeatured && <StatusBadge s="FEATURED" />}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No products.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Item 12 — canonical pagination control. Returns null when
          totalPages <= 1, so no caller-side guard needed. */}
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
