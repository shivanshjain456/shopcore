'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import ProductGalleryManager from './ProductGalleryManager';

interface Product {
  id: string; sku: string; name: string; slug: string;
  description: string; shortDesc: string | null;
  category: { slug: string; name: string };
  brand: { slug: string; name: string } | null;
  mrpPaise: number; pricePaise: number; b2bPricePaise: number | null;
  stock: number; lowStockAt: number; gstRate: number; hsnCode: string | null;
  isActive: boolean; isFeatured: boolean; aiTags: string | null;
  variants: { id: string; sku: string; name: string; stock: number; pricePaise: number; isActive: boolean }[];
}

export default function EditProductPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const router = useRouter();
  const [p, setP] = useState<Product | null>(null);
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const [r, c, b] = await Promise.all([
      api<{ product: Product }>(`/api/admin/products/${id}`),
      api<{ categories: { slug: string; name: string }[] }>('/api/categories'),
      api<{ brands: { slug: string; name: string }[] }>('/api/brands'),
    ]);
    if (r.ok && r.data) setP(r.data.product);
    setCats(c.data?.categories ?? []); setBrands(b.data?.brands ?? []);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await api(`/api/admin/products/${id}`, {
      method: 'PATCH',
      body: {
        name:         String(f.get('name') ?? ''),
        description:  String(f.get('description') ?? ''),
        shortDesc:    String(f.get('shortDesc') ?? '') || null,
        categorySlug: String(f.get('categorySlug') ?? ''),
        brandSlug:    String(f.get('brandSlug') ?? '') || null,
        mrpPaise:     Math.round(Number(f.get('mrp')) * 100),
        pricePaise:   Math.round(Number(f.get('price')) * 100),
        b2bPricePaise: f.get('b2bPrice') ? Math.round(Number(f.get('b2bPrice')) * 100) : null,
        stock:        Number(f.get('stock') || 0),
        lowStockAt:   Number(f.get('lowStockAt') || 5),
        gstRate:      Number(f.get('gstRate') || 18),
        hsnCode:      String(f.get('hsnCode') ?? '') || null,
        isActive:     f.get('isActive') === 'on',
        isFeatured:   f.get('isFeatured') === 'on',
        aiTags:       String(f.get('aiTags') ?? '') || null,
      },
    });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.error ?? 'Could not save.' }); return; }
    setMsg({ kind: 'ok', text: 'Saved.' });
    await load();
  }

  async function deleteIt() {
    const ok = await dialog.confirm({
      title: 'Delete product?',
      message: 'If this product has any orders, it will be deactivated rather than removed (so order history stays intact).',
      intent: 'destructive', confirmLabel: 'Delete product',
    });
    if (!ok) return;
    const r = await api(`/api/admin/products/${id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Delete failed', message: r.error ?? 'Please try again.' }); return; }
    router.push('/admin/products');
  }

  if (!p) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <PageHeader
        title={p.name} subtitle={`SKU ${p.sku} · ${p.variants.length} variant(s)`}
        actions={
          <>
            <Button tone="danger" onClick={deleteIt}>Delete</Button>
            <a href={`/p/${p.slug}`} target="_blank" rel="noopener noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">View on storefront ↗</a>
          </>
        }
      />
      {msg && <p className={`mb-3 rounded-md p-2 text-sm ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      <form onSubmit={onSubmit}>
        <Card>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name"><input name="name" defaultValue={p.name} className="i" /></Field>
            <Field label="Short description"><input name="shortDesc" defaultValue={p.shortDesc ?? ''} className="i" /></Field>
            <Field label="Category">
              <select name="categorySlug" defaultValue={p.category.slug} className="i bg-white">
                {cats.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Brand">
              <select name="brandSlug" defaultValue={p.brand?.slug ?? ''} className="i bg-white">
                <option value="">—</option>
                {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="MRP (₹)"><input name="mrp"   type="number" min={0} step={0.01} defaultValue={p.mrpPaise/100} className="i" /></Field>
            <Field label="Price (₹)"><input name="price" type="number" min={0} step={0.01} defaultValue={p.pricePaise/100} className="i" /></Field>
            <Field label="B2B price (₹)"><input name="b2bPrice" type="number" min={0} step={0.01} defaultValue={p.b2bPricePaise != null ? p.b2bPricePaise/100 : ''} className="i" /></Field>
            <Field label="GST rate (%)"><input name="gstRate" type="number" min={0} max={28} step={0.01} defaultValue={p.gstRate} className="i" /></Field>
            <Field label="HSN code"><input name="hsnCode" defaultValue={p.hsnCode ?? ''} className="i" /></Field>
            <Field label="Stock"><input name="stock" type="number" min={0} defaultValue={p.stock} className="i" /></Field>
            <Field label="Low-stock alert"><input name="lowStockAt" type="number" min={0} defaultValue={p.lowStockAt} className="i" /></Field>
            <div className="md:col-span-2">
              <Field label="Description"><textarea name="description" rows={6} defaultValue={p.description} className="i" /></Field>
            </div>
            <Field label="AI tags (CSV)"><input name="aiTags" defaultValue={p.aiTags ?? ''} className="i" /></Field>
            <div className="flex items-end gap-4">
              <label className="text-sm"><input name="isActive"   type="checkbox" defaultChecked={p.isActive} /> Active</label>
              <label className="text-sm"><input name="isFeatured" type="checkbox" defaultChecked={p.isFeatured} /> Featured</label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </Card>
      </form>

      {/* Item 19 — gallery manager. Lives between the product fields and
          the variants section so admins can see the basics first, then
          curate the photography. */}
      <ProductGalleryManager productId={p.id} productName={p.name} />

      <Card className="mt-4">
        <h2 className="text-sm font-bold uppercase text-slate-700">Variants ({p.variants.length})</h2>
        {p.variants.length === 0 && <p className="mt-2 text-sm text-slate-500">No variants. Use Excel import to add variants in bulk.</p>}
        {p.variants.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-left">Name</th><th className="px-2 py-1 text-right">Price</th><th className="px-2 py-1 text-right">Stock</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.variants.map((v) => (
                <tr key={v.id}><td className="px-2 py-1 font-mono text-xs">{v.sku}</td><td className="px-2 py-1">{v.name}</td><td className="px-2 py-1 text-right">₹{v.pricePaise/100}</td><td className="px-2 py-1 text-right">{v.stock}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <style jsx global>{`.i { display:block; width:100%; border:1px solid rgb(203 213 225); border-radius:0.375rem; padding:0.5rem 0.75rem; font-size:0.875rem; }`}</style>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-semibold uppercase text-slate-600">{label}</span>{children}</label>;
}
