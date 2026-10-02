'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';

export default function NewProductPage() {
  const router = useRouter();
  const [cats, setCats] = useState<{ slug: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tags, setTags] = useState<string>('');

  useEffect(() => {
    (async () => {
      const c = await api<{ categories: { slug: string; name: string }[] }>('/api/categories');
      const b = await api<{ brands: { slug: string; name: string }[] }>('/api/brands');
      setCats(c.data?.categories ?? []); setBrands(b.data?.brands ?? []);
    })();
  }, []);

  async function suggestFromDesc(desc: string, name: string) {
    const r = await api<{ tags: string[] }>('/api/admin/ai/suggest-tags', { method: 'POST', body: { text: `${name}\n${desc}` } });
    if (r.ok && r.data) setTags(r.data.tags.join(','));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await api<{ product: { id: string } }>('/api/admin/products', {
      method: 'POST',
      body: {
        sku:          String(f.get('sku') ?? '').toUpperCase(),
        name:         String(f.get('name') ?? ''),
        slug:         String(f.get('slug') ?? '') || undefined,
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
        aiTags:       tags || null,
      },
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not create.'); return; }
    router.push(`/admin/products/${r.data!.product.id}`);
  }

  return (
    <>
      <PageHeader title="New product" subtitle="Create a single product. For bulk creation, use Excel import." />
      <form onSubmit={onSubmit}>
        <Card>
          {err && <p className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-700">{err}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="SKU"><input name="sku" required className="i" /></Field>
            <Field label="Name"><input name="name" required className="i" /></Field>
            <Field label="Slug (optional)"><input name="slug" className="i" placeholder="auto-generated from name" /></Field>
            <Field label="Short description"><input name="shortDesc" className="i" /></Field>
            <Field label="Category">
              <select name="categorySlug" required className="i bg-white">
                <option value="">Select…</option>
                {cats.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Brand">
              <select name="brandSlug" className="i bg-white">
                <option value="">—</option>
                {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="MRP (₹)"><input name="mrp" type="number" min={0} step={0.01} required className="i" /></Field>
            <Field label="Price (₹)"><input name="price" type="number" min={0} step={0.01} required className="i" /></Field>
            <Field label="B2B price (₹) (optional)"><input name="b2bPrice" type="number" min={0} step={0.01} className="i" /></Field>
            <Field label="GST rate (%)"><input name="gstRate" type="number" min={0} max={28} step={0.01} defaultValue={18} className="i" /></Field>
            <Field label="HSN code"><input name="hsnCode" className="i" /></Field>
            <Field label="Stock"><input name="stock" type="number" min={0} defaultValue={0} className="i" /></Field>
            <Field label="Low-stock alert at"><input name="lowStockAt" type="number" min={0} defaultValue={5} className="i" /></Field>
            <div className="md:col-span-2">
              <Field label="Description">
                <textarea name="description" rows={6} className="i" onBlur={(e) => {
                  const desc = e.target.value;
                  const name = (e.target.form?.elements.namedItem('name') as HTMLInputElement)?.value ?? '';
                  if (desc && !tags) void suggestFromDesc(desc, name);
                }} />
              </Field>
              <p className="mt-1 text-xs text-slate-500">When you tab out of the description, AI tag suggestion runs.</p>
            </div>
            <Field label="AI tags (CSV)"><input value={tags} onChange={(e) => setTags(e.target.value)} className="i" placeholder="ssd, ram, 16gb, …" /></Field>
            <div className="flex items-end gap-4">
              <label className="text-sm"><input name="isActive" type="checkbox" defaultChecked /> Active</label>
              <label className="text-sm"><input name="isFeatured" type="checkbox" /> Featured</label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" tone="ghost" onClick={() => history.back()}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create product'}</Button>
          </div>
        </Card>
      </form>
      <style jsx global>{`
        .i { display:block; width:100%; border:1px solid rgb(203 213 225); border-radius:0.375rem; padding:0.5rem 0.75rem; font-size:0.875rem; }
      `}</style>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-semibold uppercase text-slate-600">{label}</span>{children}</label>;
}
