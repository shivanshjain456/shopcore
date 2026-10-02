'use client';
/**
 * /admin/assets — Item 17 Phase 2 dashboard.
 *
 *   Three sections:
 *     1. STORE IDENTITY — five slots from store config; each row has
 *        a green ✓ / red Missing pill + a quick "Set" link that jumps
 *        to the matching field in /admin/store-config.
 *     2. BRAND COVERAGE — table of every active brand with logo /
 *        banner / description columns; per-row green/red badges +
 *        per-row inline <ImageUploadInput> to upload directly.
 *     3. CATEGORY COVERAGE — same shape for categories (image /
 *        banner / icon / description).
 *     4. BULK UPLOAD — drag-and-drop multi-file picker that runs
 *        filename → slug matching for brand logos OR category tiles.
 *        Per-file preview of the proposed assignment; admin confirms
 *        before any HTTP upload runs.
 *     5. RECENT ASSETS — paginated StoreAsset registry with delete.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';
import BrandLogo from '@/components/storefront/BrandLogo';
import CategoryImage from '@/components/storefront/CategoryImage';
import BulkUploadCard from './BulkUploadCard';

interface HealthSlot { configured: boolean; url: string | null }
interface StoreHealth {
  logoUrl: HealthSlot; logoDarkUrl: HealthSlot; faviconUrl: HealthSlot;
  ogImageUrl: HealthSlot; appIconUrl: HealthSlot;
  total: number; configured: number;
}
interface BrandRow {
  id: string; name: string; slug: string;
  logoUrl: string | null; bannerUrl: string | null; description: string | null;
}
interface CategoryRow {
  id: string; name: string; slug: string;
  imageUrl: string | null; bannerUrl: string | null;
  iconUrl: string | null; description: string | null;
}
interface AssetRow {
  id: string; kind: string; url: string;
  width: number | null; height: number | null;
  mimeType: string | null; bytes: number | null;
  uploadedBy: string;
  uploaderEmail: string | null;
  createdAt: string;
}
interface AssetResponse {
  items: AssetRow[];
  pagination: PaginationMeta;
  health?: {
    storeIdentity: StoreHealth;
    brands:     { total: number; withLogo: number; withBanner: number; withDescription: number; brands: BrandRow[] };
    categories: { total: number; withImage: number; withBanner: number; withIcon: number; withDescription: number; categories: CategoryRow[] };
  };
}

const STORE_SLOTS: Array<{ key: keyof StoreHealth; label: string; hint: string }> = [
  { key: 'logoUrl',     label: 'Store logo',          hint: 'Header logo' },
  { key: 'logoDarkUrl', label: 'Logo (dark mode)',    hint: 'Optional' },
  { key: 'faviconUrl',  label: 'Favicon',             hint: 'Browser tab icon' },
  { key: 'ogImageUrl',  label: 'Open Graph image',    hint: 'Social-share preview' },
  { key: 'appIconUrl',  label: 'PWA app icon',        hint: 'Home-screen icon' },
];

function YesNoBadge({ ok }: { ok: boolean }) {
  return ok
    ? <StatusBadge s="ACTIVE" />
    : <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">Missing</span>;
}

function fmtBytes(n: number | null): string {
  if (n === null || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function AssetsDashboard() {
  const dialog = useDialog();
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_assets', 20);
  const [kind,     setKind]     = useState<string>('all');
  const [data, setData] = useState<AssetResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      kind,
      include: 'health',
    });
    const r = await api<AssetResponse>(`/api/admin/assets?${qs.toString()}`);
    if (r.ok && r.data) setData(r.data);
    setBusy(false);
  }, [page, pageSize, kind]);

  useEffect(() => { void load(); }, [load]);

  async function deleteAsset(id: string, url: string) {
    const ok = await dialog.confirm({
      title:        'Delete asset?',
      message:      `Permanently delete this file and registry entry?\n\n${url}\n\nIf any Brand / Category / Store-config field still points at it, you'll be told first.`,
      confirmLabel: 'Delete',
      intent:       'destructive',
    });
    if (!ok) return;
    const r = await api<{ ok: true }>(`/api/admin/assets/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const refs = (r.raw as { references?: Array<{ entity: string }> }).references ?? [];
      const refList = refs.length ? '\n\n• ' + refs.map((x) => x.entity).join('\n• ') : '';
      await dialog.alert({
        title:   'Could not delete',
        message: (r.error ?? 'Delete failed.') + refList,
      });
      return;
    }
    await load();
  }

  const totalAssets = data?.pagination.total ?? 0;
  const totalBytes  = useMemo(() => (data?.items ?? []).reduce((s, a) => s + (a.bytes ?? 0), 0), [data]);

  return (
    <>
      <PageHeader
        title="Brand assets"
        subtitle="Upload coverage across the store, brands, and categories. Manage every uploaded file."
      />

      {/* ── 1. Store identity ──────────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Store identity</h2>
        {data?.health ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STORE_SLOTS.map((slot) => {
              const s = data.health!.storeIdentity[slot.key] as HealthSlot;
              return (
                <div key={slot.key as string} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{slot.label}</p>
                      <p className="text-[11px] text-slate-500">{slot.hint}</p>
                    </div>
                    <YesNoBadge ok={s.configured} />
                  </div>
                  {s.configured ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={s.url ?? ''} alt={slot.label} className="mt-2 h-12 max-w-full rounded object-contain" />
                  ) : (
                    <a href="/admin/store-config" className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline">Set in Store config →</a>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{busy ? 'Loading…' : 'No data.'}</p>
        )}
        {data?.health && (
          <p className="mt-3 text-xs text-slate-600">
            <strong>{data.health.storeIdentity.configured}</strong> of <strong>{data.health.storeIdentity.total}</strong> store-identity slots configured.
          </p>
        )}
      </Card>

      {/* ── 2. Brand coverage ──────────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Brand coverage</h2>
        {data?.health ? (
          <>
            <p className="mb-3 text-xs text-slate-600">
              <strong>{data.health.brands.withLogo}</strong> of <strong>{data.health.brands.total}</strong> brands have logos
              · <strong>{data.health.brands.withBanner}</strong> have banners
              · <strong>{data.health.brands.withDescription}</strong> have descriptions
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Brand</th>
                    <th className="px-3 py-2 text-left">Logo</th>
                    <th className="px-3 py-2 text-left">Banner</th>
                    <th className="px-3 py-2 text-left">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.health.brands.brands.map((b) => (
                    <tr key={b.id}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <BrandLogo logoUrl={b.logoUrl} name={b.name} size={28} />
                          <span className="font-semibold">{b.name}</span>
                          <code className="text-[10px] text-slate-500">{b.slug}</code>
                        </div>
                      </td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!b.logoUrl} /></td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!b.bannerUrl} /></td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!b.description} /></td>
                    </tr>
                  ))}
                  {data.health.brands.brands.length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-xs text-slate-500">No active brands.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-500">{busy ? 'Loading…' : 'No data.'}</p>
        )}
      </Card>

      {/* ── 3. Category coverage ──────────────────────────────────── */}
      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Category coverage</h2>
        {data?.health ? (
          <>
            <p className="mb-3 text-xs text-slate-600">
              <strong>{data.health.categories.withImage}</strong> of <strong>{data.health.categories.total}</strong> categories have tile images
              · <strong>{data.health.categories.withBanner}</strong> have banners
              · <strong>{data.health.categories.withIcon}</strong> have nav icons
              · <strong>{data.health.categories.withDescription}</strong> have descriptions
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Category</th>
                    <th className="px-3 py-2 text-left">Tile</th>
                    <th className="px-3 py-2 text-left">Banner</th>
                    <th className="px-3 py-2 text-left">Icon</th>
                    <th className="px-3 py-2 text-left">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.health.categories.categories.map((cat) => (
                    <tr key={cat.id}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-10 shrink-0">
                            <CategoryImage imageUrl={cat.imageUrl} name={cat.name} aspect="tile" />
                          </div>
                          <span className="font-semibold">{cat.name}</span>
                          <code className="text-[10px] text-slate-500">{cat.slug}</code>
                        </div>
                      </td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!cat.imageUrl} /></td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!cat.bannerUrl} /></td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!cat.iconUrl} /></td>
                      <td className="px-3 py-2"><YesNoBadge ok={!!cat.description} /></td>
                    </tr>
                  ))}
                  {data.health.categories.categories.length === 0 && (
                    <tr><td colSpan={5} className="p-4 text-center text-xs text-slate-500">No active categories.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-500">{busy ? 'Loading…' : 'No data.'}</p>
        )}
      </Card>

      {/* ── 4. Bulk upload ─────────────────────────────────────────── */}
      <BulkUploadCard
        brands={data?.health?.brands.brands ?? []}
        categories={data?.health?.categories.categories ?? []}
        onUploaded={() => void load()}
      />

      {/* ── 5. Recent uploads (paginated registry) ─────────────────── */}
      <Card className="mt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Recent uploads</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600">Filter:</label>
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value); setPage(1); }}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="all">All kinds</option>
              {['logo','favicon','og_image','app_icon','brand','category','category_banner','category_icon','hero','promotion','misc'].map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <Button tone="ghost" onClick={() => void load()} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>
          </div>
        </div>
        <p className="mb-3 text-xs text-slate-600">
          <strong>{totalAssets}</strong> registered asset{totalAssets === 1 ? '' : 's'}
          {totalBytes > 0 && <> · <strong>{fmtBytes(totalBytes)}</strong> on this page</>}
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Preview</th>
                <th className="px-3 py-2 text-left">Kind</th>
                <th className="px-3 py-2 text-left">Dimensions</th>
                <th className="px-3 py-2 text-left">Size</th>
                <th className="px-3 py-2 text-left">Uploaded by</th>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data?.items ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.url} alt={`${a.kind} preview`} className="h-10 w-16 rounded border border-slate-200 object-contain" />
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">{a.kind}</td>
                  <td className="px-3 py-2 text-xs">{a.width && a.height ? `${a.width}×${a.height}` : '—'}</td>
                  <td className="px-3 py-2 text-xs">{fmtBytes(a.bytes)}</td>
                  <td className="px-3 py-2 text-xs">{a.uploaderEmail ?? a.uploadedBy.slice(0,8)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{new Date(a.createdAt).toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 text-right">
                    <Button tone="danger" onClick={() => void deleteAsset(a.id, a.url)}>Delete</Button>
                  </td>
                </tr>
              ))}
              {(data?.items ?? []).length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-xs text-slate-500">{busy ? 'Loading…' : 'No assets yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data?.pagination && (
          <Pagination
            currentPage={data.pagination.page}
            totalPages={data.pagination.totalPages}
            pageSize={data.pagination.pageSize}
            totalItems={data.pagination.total}
            onPageChange={(p) => setPage(p)}
            showPageSizeSelector
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
            jumpInputThreshold={10}
            keyboardNav
          />
        )}
      </Card>
    </>
  );
}
