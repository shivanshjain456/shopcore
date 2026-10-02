'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Coupon {
  id: string; code: string; description: string | null; discountType: string; value: number;
  minOrderPaise: number; maxDiscountPaise: number | null; usageLimit: number | null; perUserLimit: number | null;
  usedCount: number; validFrom: string; validUntil: string; isActive: boolean;
  appliesToB2C: boolean; appliesToB2B: boolean;
}

export default function CouponsAdmin() {
  const [items, setItems] = useState<Coupon[]>([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_coupons', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Coupon[]; pagination: PaginationMeta }>(`/api/admin/coupons?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setErr(null);
    const f = new FormData(e.currentTarget);
    const r = await api('/api/admin/coupons', { method: 'POST', body: {
      code: String(f.get('code') ?? ''),
      description: String(f.get('description') ?? '') || null,
      discountType: String(f.get('discountType') ?? ''),
      value: Number(f.get('value') || 0),
      minOrderPaise: Math.round(Number(f.get('minOrder') || 0) * 100),
      maxDiscountPaise: f.get('maxDiscount') ? Math.round(Number(f.get('maxDiscount')) * 100) : null,
      usageLimit:   f.get('usageLimit')   ? Number(f.get('usageLimit'))   : null,
      perUserLimit: f.get('perUserLimit') ? Number(f.get('perUserLimit')) : null,
      validFrom:  String(f.get('validFrom')  ?? ''),
      validUntil: String(f.get('validUntil') ?? ''),
      appliesToB2C: f.get('appliesToB2C') === 'on',
      appliesToB2B: f.get('appliesToB2B') === 'on',
      isActive: true,
    } });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Failed.'); return; }
    setShow(false); await load();
  }

  async function setActive(id: string, isActive: boolean) {
    await api(`/api/admin/coupons/${id}`, { method: 'PATCH', body: { isActive } }); await load();
  }
  async function del(id: string) {
    const ok = await dialog.confirm({
      title: 'Delete coupon?',
      message: 'If the coupon has already been used, it will be deactivated instead of deleted.',
      intent: 'destructive', confirmLabel: 'Delete coupon',
    });
    if (!ok) return;
    await api(`/api/admin/coupons/${id}`, { method: 'DELETE' }); await load();
  }

  return (
    <>
      <PageHeader title="Coupons" subtitle="Promo codes for B2C / B2B."
        actions={<Button onClick={() => setShow((s) => !s)}>{show ? 'Close' : '+ New coupon'}</Button>} />
      {show && (
        <Card className="mb-3">
          {err && <p className="mb-2 text-sm text-red-700">{err}</p>}
          <form onSubmit={create} className="grid gap-3 md:grid-cols-3">
            <label className="text-xs">Code <input name="code" required className="i mt-1" /></label>
            <label className="text-xs">Description <input name="description" className="i mt-1" /></label>
            <label className="text-xs">Type
              <select name="discountType" required className="i mt-1 bg-white">
                <option value="PERCENT">PERCENT</option>
                <option value="FLAT">FLAT (paise)</option>
                <option value="FREE_SHIPPING">FREE_SHIPPING</option>
              </select>
            </label>
            <label className="text-xs">Value <input name="value" type="number" min={0} required className="i mt-1" /></label>
            <label className="text-xs">Min order ₹ <input name="minOrder" type="number" min={0} step={0.01} defaultValue={0} className="i mt-1" /></label>
            <label className="text-xs">Max discount ₹ <input name="maxDiscount" type="number" min={0} step={0.01} className="i mt-1" /></label>
            <label className="text-xs">Total uses <input name="usageLimit" type="number" min={1} className="i mt-1" /></label>
            <label className="text-xs">Per-user uses <input name="perUserLimit" type="number" min={1} className="i mt-1" /></label>
            <label className="text-xs">Valid from <input name="validFrom" type="datetime-local" required className="i mt-1" /></label>
            <label className="text-xs">Valid until <input name="validUntil" type="datetime-local" required className="i mt-1" /></label>
            <label className="text-sm"><input name="appliesToB2C" type="checkbox" defaultChecked /> B2C</label>
            <label className="text-sm"><input name="appliesToB2B" type="checkbox" /> B2B</label>
            <div className="md:col-span-3"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create'}</Button></div>
          </form>
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Code</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2 text-right">Used</th><th className="px-3 py-2 text-left">Window</th><th className="px-3 py-2 text-left">Scope</th><th className="px-3 py-2 text-left">State</th><th className="px-3 py-2 text-left">Actions</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2 font-mono text-xs">{c.code}<br/><span className="text-[10px] text-slate-500">{c.description ?? ''}</span></td>
                <td className="px-3 py-2 text-xs">{c.discountType}</td>
                <td className="px-3 py-2 text-right text-xs">{c.discountType === 'PERCENT' ? `${c.value}%` : c.discountType === 'FLAT' ? rupees(c.value) : '—'}</td>
                <td className="px-3 py-2 text-right text-xs">{c.usedCount}{c.usageLimit ? ` / ${c.usageLimit}` : ''}</td>
                <td className="px-3 py-2 text-xs">{new Date(c.validFrom).toLocaleDateString('en-IN')} → {new Date(c.validUntil).toLocaleDateString('en-IN')}</td>
                <td className="px-3 py-2 text-xs">{c.appliesToB2C ? 'B2C ' : ''}{c.appliesToB2B ? 'B2B' : ''}</td>
                <td className="px-3 py-2"><StatusBadge s={c.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                <td className="px-3 py-2 space-x-1">
                  {c.isActive ? <Button tone="ghost" onClick={() => setActive(c.id, false)}>Disable</Button>
                              : <Button onClick={() => setActive(c.id, true)}>Enable</Button>}
                  <Button tone="danger" onClick={() => del(c.id)}>Delete</Button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-500">No coupons.</td></tr>}
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
