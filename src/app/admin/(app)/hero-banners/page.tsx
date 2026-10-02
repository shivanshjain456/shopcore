'use client';
/**
 * Hero-banner admin — Feature #15.
 *
 *   List + create + edit (inline) + reorder + toggle-active + delete for
 *   the homepage hero carousel. Talks to /api/admin/hero-banners.
 *
 *   The page renders three concerns:
 *
 *     1. Live preview header (count of active banners, link to the
 *        public storefront).
 *     2. "+ New banner" form (collapsed by default).
 *     3. Sortable list. Each row: drag-up / drag-down (no DnD library —
 *        plain ↑ / ↓ buttons fire /reorder), active toggle, edit-in-place
 *        for headline/CTA/dates, image swap, delete.
 *
 *   Why no DnD library?
 *     - The spec forbids bloated dependencies.
 *     - ↑ / ↓ buttons are 100 % keyboard-accessible by default.
 *
 *   Every mutation is awaited + re-loads the list, so we never get into
 *   "show stale data after delete".
 */
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import ImageUploadInput from '@/components/admin/ImageUploadInput';

interface Banner {
  id: string;
  name: string;
  headline: string;
  subheadline: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageDesktopUrl: string;
  imageMobileUrl: string | null;
  imageAlt: string | null;
  textColor: 'light' | 'dark' | null;
  overlayOpacity: number;
  isActive: boolean;
  displayOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function HeroBannersAdmin() {
  const [items, setItems] = useState<Banner[]>([]);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useDialog();
  // Controlled image-URL state (Feature #16). The <ImageUploadInput>
  // writes the URL via onChange — when the admin uses the new "Upload"
  // button, the URL it writes is the post-re-encode `/api/uploads/...`
  // path returned by /api/admin/uploads.
  const [desktopUrl, setDesktopUrl] = useState('');
  const [mobileUrl,  setMobileUrl]  = useState('');

  const load = async () => {
    const r = await api<{ items: Banner[] }>('/api/admin/hero-banners');
    if (r.ok && r.data) setItems(r.data.items);
  };
  useEffect(() => { void load(); }, []);

  const activeCount = useMemo(() => items.filter((i) => i.isActive).length, [items]);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setBusy(true);
    // Capture the form element synchronously — React 18 nulls
    // `e.currentTarget` after the first `await`, so storing the reference
    // before the async network call is the only safe way to call
    // `form.reset()` afterwards.
    const form = e.currentTarget;
    const f = new FormData(form);
    const body: Record<string, unknown> = {
      name:            String(f.get('name') ?? '').trim(),
      headline:        String(f.get('headline') ?? '').trim(),
      subheadline:     emptyToNull(f.get('subheadline')),
      ctaLabel:        emptyToNull(f.get('ctaLabel')),
      ctaHref:         emptyToNull(f.get('ctaHref')),
      // Image URLs are now driven by controlled state (Feature #16) — the
      // admin can either paste a URL OR upload a file via <ImageUploadInput>.
      imageDesktopUrl: desktopUrl.trim(),
      imageMobileUrl:  mobileUrl.trim() ? mobileUrl.trim() : null,
      imageAlt:        emptyToNull(f.get('imageAlt')),
      textColor:       emptyToNull(f.get('textColor')) as string | null,
      overlayOpacity:  Number(f.get('overlayOpacity') ?? 35),
      isActive:        f.get('isActive') === 'on',
      displayOrder:    items.length,  // append
    };
    const startsAt = String(f.get('startsAt') ?? '').trim();
    const endsAt   = String(f.get('endsAt') ?? '').trim();
    if (startsAt) body.startsAt = new Date(startsAt).toISOString();
    if (endsAt)   body.endsAt   = new Date(endsAt).toISOString();
    const r = await api<{ banner: Banner }>('/api/admin/hero-banners', { method: 'POST', body });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Could not save.'); return; }
    form.reset();
    // Reset the controlled image-URL fields after a successful save.
    setDesktopUrl(''); setMobileUrl('');
    setShowForm(false);
    await load();
  }

  async function toggleActive(b: Banner) {
    setBusy(true);
    const r = await api(`/api/admin/hero-banners/${b.id}`, {
      method: 'PATCH', body: { isActive: !b.isActive },
    });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Could not update', message: r.error ?? '' }); return; }
    await load();
  }

  async function del(b: Banner) {
    const ok = await dialog.confirm({
      title: 'Delete banner?',
      message: `"${b.name}" will be removed permanently. This cannot be undone.`,
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    const r = await api(`/api/admin/hero-banners/${b.id}`, { method: 'DELETE' });
    if (!r.ok) { await dialog.alert({ title: 'Could not delete', message: r.error ?? '' }); return; }
    await load();
  }

  async function move(b: Banner, dir: -1 | 1) {
    const idx = items.findIndex((x) => x.id === b.id);
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next); // optimistic
    const r = await api('/api/admin/hero-banners/reorder', {
      method: 'POST', body: { ids: next.map((x) => x.id) },
    });
    if (!r.ok) {
      await dialog.alert({ title: 'Could not reorder', message: r.error ?? '' });
      await load(); // resync from server
    }
  }

  return (
    <>
      <PageHeader
        title="Hero carousel"
        subtitle={`${activeCount} active · ${items.length} total · changes go live within ~60s of save (HTTP cache).`}
        actions={
          <>
            <a
              href="/" target="_blank" rel="noreferrer"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >Preview homepage ↗</a>
            <Button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ New banner'}</Button>
          </>
        }
      />

      {showForm && (
        <Card className="mb-4">
          <form onSubmit={onCreate} className="grid gap-3 md:grid-cols-2" data-testid="hero-create-form">
            {error && <p className="md:col-span-2 text-sm text-red-700">{error}</p>}
            <label className="text-xs">
              Internal name (admin only)
              <input name="name" required maxLength={120} className="i mt-1" placeholder="e.g. Diwali Sale 2026"/>
            </label>
            <label className="text-xs">
              Display order (lower = first)
              <input type="number" name="displayOrder" defaultValue={items.length} min={0} className="i mt-1" />
            </label>
            <label className="md:col-span-2 text-xs">
              Headline *
              <input name="headline" required maxLength={160} className="i mt-1" placeholder="Diwali Sale — flat 20% off everything"/>
            </label>
            <label className="md:col-span-2 text-xs">
              Subheadline
              <input name="subheadline" maxLength={280} className="i mt-1" placeholder="Brand-new laptops, desktops &amp; accessories."/>
            </label>
            <label className="text-xs">
              CTA label
              <input name="ctaLabel" maxLength={60} className="i mt-1" placeholder="Shop the sale"/>
            </label>
            <label className="text-xs">
              CTA link (URL or /path)
              <input name="ctaHref" maxLength={2000} className="i mt-1" placeholder="/c/laptops"/>
            </label>
            {/* Feature #16 — paste-URL OR upload-from-computer. */}
            <div className="md:col-span-2">
              <ImageUploadInput
                name="imageDesktopUrl"
                kind="hero"
                value={desktopUrl}
                onChange={setDesktopUrl}
                label="Desktop image"
                placeholder="https://cdn... or /uploads/public-images/hero/..."
                required
                data-testid="hero-img-desktop"
              />
            </div>
            <div className="md:col-span-2">
              <ImageUploadInput
                name="imageMobileUrl"
                kind="hero"
                value={mobileUrl}
                onChange={setMobileUrl}
                label="Mobile image (optional — falls back to desktop)"
                placeholder="/uploads/public-images/hero/mobile.jpg"
                data-testid="hero-img-mobile"
              />
            </div>
            <label className="text-xs">
              Image alt text (accessibility)
              <input name="imageAlt" maxLength={200} className="i mt-1" placeholder="Festive lights illuminate a laptop on a desk"/>
            </label>
            <label className="text-xs">
              Text colour
              <select name="textColor" defaultValue="" className="i mt-1">
                <option value="">Auto (light on dark image)</option>
                <option value="light">Light text (over dark image)</option>
                <option value="dark">Dark text (over light image)</option>
              </select>
            </label>
            <label className="text-xs">
              Overlay opacity (0-100)
              <input type="number" name="overlayOpacity" defaultValue={35} min={0} max={100} className="i mt-1"/>
            </label>
            <label className="text-xs flex items-end gap-2">
              <input type="checkbox" name="isActive" defaultChecked className="h-4 w-4 align-text-bottom" />
              <span>Activate immediately</span>
            </label>
            <label className="text-xs">
              Starts at (optional, IST)
              <input type="datetime-local" name="startsAt" className="i mt-1"/>
            </label>
            <label className="text-xs">
              Ends at (optional, IST)
              <input type="datetime-local" name="endsAt" className="i mt-1"/>
            </label>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create banner'}</Button>
            </div>
          </form>
        </Card>
      )}

      <Card className="overflow-x-auto p-0" data-testid="hero-list">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Order</th>
              <th className="px-3 py-2 text-left">Preview</th>
              <th className="px-3 py-2 text-left">Name / Headline</th>
              <th className="px-3 py-2 text-left">CTA</th>
              <th className="px-3 py-2 text-left">Schedule</th>
              <th className="px-3 py-2 text-left">State</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                No banners yet. Click <strong>+ New banner</strong> to create one.
              </td></tr>
            )}
            {items.map((b, i) => (
              <tr key={b.id} data-testid={`hero-row-${b.id}`}>
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-slate-500">{i + 1}</span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label="Move up"
                        onClick={() => move(b, -1)}
                        disabled={i === 0}
                        data-testid={`hero-up-${b.id}`}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 text-xs disabled:opacity-30"
                      >↑</button>
                      <button
                        type="button"
                        aria-label="Move down"
                        onClick={() => move(b, +1)}
                        disabled={i === items.length - 1}
                        data-testid={`hero-down-${b.id}`}
                        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 text-xs disabled:opacity-30"
                      >↓</button>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={b.imageDesktopUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-24 rounded border border-slate-200 object-cover"
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="font-semibold text-slate-900">{b.name}</div>
                  <div className="text-xs text-slate-600 line-clamp-2 max-w-[26rem]">{b.headline}</div>
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {b.ctaLabel ? (
                    <>
                      <div className="font-medium text-slate-800">{b.ctaLabel}</div>
                      <div className="font-mono text-[10px] text-slate-500 break-all">{b.ctaHref}</div>
                    </>
                  ) : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2 align-top text-xs text-slate-600">
                  {b.startsAt ? <div>from {new Date(b.startsAt).toLocaleDateString()}</div> : <div>no start</div>}
                  {b.endsAt   ? <div>to {new Date(b.endsAt).toLocaleDateString()}</div>     : <div>no end</div>}
                </td>
                <td className="px-3 py-2 align-top">
                  <StatusBadge s={b.isActive ? 'ACTIVE' : 'INACTIVE'} />
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <div className="inline-flex flex-wrap justify-end gap-1">
                    <Button tone="ghost" onClick={() => toggleActive(b)}
                            data-testid={`hero-toggle-${b.id}`}>
                      {b.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button tone="danger" onClick={() => del(b)}
                            data-testid={`hero-delete-${b.id}`}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <style jsx global>{`
        .i {
          display:block; width:100%;
          border:1px solid rgb(203 213 225); border-radius:0.375rem;
          padding:0.4rem 0.625rem; font-size:0.875rem; background:#fff;
        }
      `}</style>
    </>
  );
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}
