'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import CategoryImage from '@/components/storefront/CategoryImage';
import type { PaginationMeta } from '@/lib/pagination';

interface Cat {
  id: string; name: string; slug: string;
  description: string | null;
  sortOrder: number; isActive: boolean;
  // Item 17 — category asset fields. All optional; <CategoryImage>
  //   shows a gradient fallback when imageUrl is missing.
  imageUrl?: string | null;
  bannerUrl?: string | null;
  iconUrl?: string | null;
  _count: { products: number };
}

export default function CategoriesAdmin() {
  const [items, setItems] = useState<Cat[]>([]);
  const [show, setShow] = useState(false);
  const [imageUrl,  setImageUrl]  = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [iconUrl,   setIconUrl]   = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_categories', 50);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const dialog = useDialog();
  const load = async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const r = await api<{ items: Cat[]; pagination: PaginationMeta }>(`/api/admin/categories?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await api('/api/admin/categories', { method: 'POST', body: {
      name:        String(f.get('name')),
      slug:        String(f.get('slug')).toLowerCase(),
      description: String(f.get('description') ?? '') || null,
      sortOrder:   Number(f.get('sortOrder') || 0),
      isActive:    true,
      imageUrl:    imageUrl.trim()  || null,
      bannerUrl:   bannerUrl.trim() || null,
      iconUrl:     iconUrl.trim()   || null,
    }});
    if (!r.ok) { await dialog.alert({ title: 'Could not create category', message: r.error ?? 'Please try again.' }); return; }
    setImageUrl(''); setBannerUrl(''); setIconUrl('');
    setShow(false); await load();
  }
  return (
    <>
      <PageHeader title="Categories" actions={<Button onClick={() => setShow((s) => !s)}>{show ? 'Close' : '+ New'}</Button>} />
      {show && (
        <Card className="mb-3">
          <form onSubmit={create} className="grid gap-3 md:grid-cols-2">
            <label className="text-xs">Name <input name="name" required className="i mt-1" /></label>
            <label className="text-xs">Slug <input name="slug" required pattern="[a-z0-9-]+" className="i mt-1" /></label>
            <label className="text-xs md:col-span-2">Description <input name="description" className="i mt-1" maxLength={500} /></label>
            <div><ImageUploadInput name="imageUrl"  kind="category"         value={imageUrl}  onChange={setImageUrl}  label="Tile image" /></div>
            <div><ImageUploadInput name="bannerUrl" kind="category_banner"  value={bannerUrl} onChange={setBannerUrl} label="Banner" /></div>
            <div><ImageUploadInput name="iconUrl"   kind="category_icon"    value={iconUrl}   onChange={setIconUrl}   label="Nav icon" /></div>
            <label className="text-xs">Sort order <input name="sortOrder" type="number" defaultValue={0} className="i mt-1" /></label>
            <div className="md:col-span-2"><Button type="submit">Create</Button></div>
          </form>
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm"><thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Slug</th><th className="px-3 py-2 text-right">Products</th><th className="px-3 py-2 text-left">State</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((cat) => (
              <tr key={cat.id}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-9 w-12 shrink-0">
                      <CategoryImage imageUrl={cat.imageUrl} name={cat.name} aspect="tile" />
                    </div>
                    <span className="font-semibold">{cat.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{cat.slug}</td>
                <td className="px-3 py-2 text-right">{cat._count.products}</td>
                <td className="px-3 py-2"><StatusBadge s={cat.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
              </tr>
            ))}
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
