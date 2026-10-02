'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Promo { id: string; name: string; bannerUrl: string | null; linkUrl: string | null; description: string | null; validFrom: string; validUntil: string; position: string; isActive: boolean; }

export default function PromotionsAdmin() {
  const [items, setItems] = useState<Promo[]>([]);
  const [show, setShow] = useState(false);
  // Controlled banner-URL state (Feature #16) — the <ImageUploadInput>
  // writes into it whether the admin pastes a URL or uploads a file.
  const [bannerUrl, setBannerUrl] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_promotions', 20);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Promo[]; pagination: PaginationMeta }>(`/api/admin/promotions?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await api('/api/admin/promotions', { method: 'POST', body: {
      name: String(f.get('name') ?? ''),
      bannerUrl: bannerUrl.trim() || null,
      linkUrl: String(f.get('linkUrl') ?? '') || null,
      description: String(f.get('description') ?? '') || null,
      validFrom: String(f.get('validFrom') ?? ''),
      validUntil: String(f.get('validUntil') ?? ''),
      position: String(f.get('position') ?? 'HOME_HERO'),
      isActive: true,
    } });
    if (!r.ok) { await dialog.alert({ title: 'Could not save promotion', message: r.error ?? 'Please try again.' }); return; }
    setBannerUrl('');
    setShow(false); await load();
  }

  return (
    <>
      <PageHeader title="Promotions" subtitle="Storefront banners and strips."
        actions={<Button onClick={() => setShow((s) => !s)}>{show ? 'Close' : '+ New promotion'}</Button>} />
      {show && (
        <Card className="mb-3">
          <form onSubmit={create} className="grid gap-3 md:grid-cols-2">
            <label className="text-xs">Name <input name="name" required className="i mt-1" /></label>
            <label className="text-xs">Position
              <select name="position" required className="i mt-1 bg-white">
                <option value="HOME_HERO">HOME_HERO</option>
                <option value="HOME_STRIP">HOME_STRIP</option>
                <option value="SIDEBAR">SIDEBAR</option>
              </select>
            </label>
            <div className="md:col-span-2">
              {/* Feature #16 — paste URL OR upload directly from computer. */}
              <ImageUploadInput
                name="bannerUrl"
                kind="promotion"
                value={bannerUrl}
                onChange={setBannerUrl}
                label="Banner image"
                data-testid="promotion-banner"
              />
            </div>
            <label className="text-xs md:col-span-2">Link URL <input name="linkUrl" className="i mt-1" /></label>
            <label className="text-xs md:col-span-2">Description <input name="description" className="i mt-1" /></label>
            <label className="text-xs">Valid from <input name="validFrom" type="datetime-local" required className="i mt-1" /></label>
            <label className="text-xs">Valid until <input name="validUntil" type="datetime-local" required className="i mt-1" /></label>
            <div className="md:col-span-2"><Button type="submit">Create</Button></div>
          </form>
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Position</th><th className="px-3 py-2 text-left">Window</th><th className="px-3 py-2 text-left">State</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2"><strong>{p.name}</strong>{p.description && <><br/><span className="text-xs text-slate-500">{p.description}</span></>}</td>
                <td className="px-3 py-2 text-xs">{p.position}</td>
                <td className="px-3 py-2 text-xs">{new Date(p.validFrom).toLocaleDateString('en-IN')} → {new Date(p.validUntil).toLocaleDateString('en-IN')}</td>
                <td className="px-3 py-2"><StatusBadge s={p.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">No promotions.</td></tr>}
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
