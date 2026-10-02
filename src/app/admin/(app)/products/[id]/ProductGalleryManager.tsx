'use client';
/**
 * ProductGalleryManager — Item 19.
 *
 *   Mounted in the product edit page. Lets the admin:
 *     - upload multiple images (file picker + drag-and-drop)
 *     - reorder via ↑ / ↓ buttons (keyboard-accessible) + HTML5 DnD
 *     - mark exactly one image as primary
 *     - edit per-image alt text
 *     - toggle isActive (soft-disable without losing the upload)
 *     - delete with confirm dialog
 *
 *   All mutations talk to /api/admin/products/[id]/images and
 *   re-load the list on every save so the UI never shows stale state.
 */
import React, {
  ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '@/lib/client/api';
import { Button, Card, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';

interface GalleryImage {
  id:        string;
  productId: string;
  url:       string;
  alt:       string | null;
  sortOrder: number;
  isPrimary: boolean;
  isActive:  boolean;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  productId: string;
  /** Initial fallback when the product itself has no images yet — used
   *  for the empty-state hint. */
  productName: string;
  /** Admin-configured cap. Default 12. */
  maxImages?: number;
}

type Busy = 'idle' | 'loading' | 'uploading' | 'mutating';

export default function ProductGalleryManager({
  productId, productName, maxImages = 12,
}: Props) {
  const dialog = useDialog();
  const [items, setItems]       = useState<GalleryImage[]>([]);
  const [busy, setBusy]         = useState<Busy>('idle');
  const [error, setError]       = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [dragHoverId, setDragHoverId] = useState<string | null>(null);
  const [dragId, setDragId]     = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [maxCap, setMaxCap] = useState<number>(maxImages);
  const [galleryEnabled, setGalleryEnabled] = useState<boolean>(true);
  const load = useCallback(async () => {
    setBusy('loading'); setError(null);
    const r = await api<{ items: GalleryImage[]; maxImages?: number; galleryEnabled?: boolean }>(`/api/admin/products/${productId}/images`);
    setBusy('idle');
    if (r.ok && r.data) {
      setItems(r.data.items);
      if (typeof r.data.maxImages === 'number') setMaxCap(r.data.maxImages);
      if (typeof r.data.galleryEnabled === 'boolean') setGalleryEnabled(r.data.galleryEnabled);
    } else {
      setError(r.error ?? 'Could not load gallery.');
    }
  }, [productId]);

  useEffect(() => { void load(); }, [load]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    setBusy('uploading');
    let ok = 0, failed = 0;
    for (const file of list) {
      if (items.length + ok >= maxCap) {
        failed++;
        continue;
      }
      const form = new FormData();
      form.append('file', file);
      form.append('alt',  productName);
      // The api() helper JSON-stringifies — for multipart we use raw fetch
      // + CSRF (same pattern as <ImageUploadInput>).
      const csrf = readCookie('sc_csrf') ?? (await fetchCsrf());
      const res = await fetch(`/api/admin/products/${productId}/images`, {
        method: 'POST',
        headers: csrf ? { 'x-csrf-token': csrf } : undefined,
        body: form,
        credentials: 'same-origin',
      });
      if (res.ok) { ok++; } else { failed++; }
    }
    setBusy('idle');
    setUploadMsg(
      failed === 0
        ? `Uploaded ${ok} image${ok === 1 ? '' : 's'}.`
        : `Uploaded ${ok}, ${failed} failed.`,
    );
    await load();
    if (fileRef.current) fileRef.current.value = '';
  }

  async function setPrimary(image: GalleryImage) {
    if (image.isPrimary) return;
    setBusy('mutating');
    const r = await api(`/api/admin/products/${productId}/images/${image.id}/primary`, { method: 'POST' });
    setBusy('idle');
    if (!r.ok) { await dialog.alert({ title: 'Could not set primary', message: r.error ?? '' }); return; }
    await load();
  }

  async function toggleActive(image: GalleryImage) {
    setBusy('mutating');
    const r = await api(`/api/admin/products/${productId}/images/${image.id}`, {
      method: 'PATCH', body: { isActive: !image.isActive },
    });
    setBusy('idle');
    if (!r.ok) { await dialog.alert({ title: 'Could not update', message: r.error ?? '' }); return; }
    await load();
  }

  async function saveAlt(image: GalleryImage, nextAlt: string) {
    setBusy('mutating');
    const r = await api(`/api/admin/products/${productId}/images/${image.id}`, {
      method: 'PATCH', body: { alt: nextAlt },
    });
    setBusy('idle');
    if (!r.ok) { await dialog.alert({ title: 'Could not save alt text', message: r.error ?? '' }); return; }
    await load();
  }

  async function deleteRow(image: GalleryImage) {
    const ok = await dialog.confirm({
      title:   'Remove this image?',
      message: 'This will remove the image from the product gallery. The underlying file remains in storage and can be re-attached later if needed.',
      intent:  'destructive', confirmLabel: 'Remove',
    });
    if (!ok) return;
    setBusy('mutating');
    const r = await api(`/api/admin/products/${productId}/images/${image.id}`, { method: 'DELETE' });
    setBusy('idle');
    if (!r.ok) { await dialog.alert({ title: 'Delete failed', message: r.error ?? '' }); return; }
    await load();
  }

  async function persistOrder(orderedIds: string[]) {
    setBusy('mutating');
    const r = await api(`/api/admin/products/${productId}/images/reorder`, {
      method: 'POST', body: { orderedIds },
    });
    setBusy('idle');
    if (!r.ok) { await dialog.alert({ title: 'Reorder failed', message: r.error ?? '' }); }
    await load();
  }

  async function move(image: GalleryImage, dir: -1 | 1) {
    const ids = items.map((i) => i.id);
    const idx = ids.indexOf(image.id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap]!, ids[idx]!];
    await persistOrder(ids);
  }

  // ── Drag handlers ────────────────────────────────────────────────────
  function onDragStart(e: DragEvent<HTMLLIElement>, id: string) {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
  function onDragOver(e: DragEvent<HTMLLIElement>, id: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragHoverId !== id) setDragHoverId(id);
  }
  function onDragLeave() { setDragHoverId(null); }
  async function onDrop(e: DragEvent<HTMLLIElement>, targetId: string) {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null); setDragHoverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(sourceId);
    const to   = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const reordered = ids.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    await persistOrder(reordered);
  }
  function onDragEnd() { setDragId(null); setDragHoverId(null); }

  // ── Drag-and-drop file upload zone ───────────────────────────────────
  const [dropZoneHot, setDropZoneHot] = useState(false);
  function onZoneOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); setDropZoneHot(true);
  }
  function onZoneLeave() { setDropZoneHot(false); }
  function onZoneDrop(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault(); setDropZoneHot(false);
    void uploadFiles(e.dataTransfer.files);
  }

  const remaining = Math.max(0, maxCap - items.length);
  const uploading = busy === 'uploading';

  return (
    <Card className="mt-4" data-testid="product-gallery-manager">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase text-slate-700">
          Gallery <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-600">{items.length} / {maxCap}</span>
          {!galleryEnabled && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
              Storefront gallery disabled
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,image/avif"
            multiple
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (e.currentTarget.files && e.currentTarget.files.length > 0) void uploadFiles(e.currentTarget.files);
            }}
            disabled={uploading || remaining === 0}
            className="hidden"
            data-testid="gallery-file-input"
          />
          <Button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || remaining === 0}
          >{uploading ? 'Uploading\u2026' : '+ Upload images'}</Button>
        </div>
      </div>

      {error && <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {uploadMsg && <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{uploadMsg}</p>}

      <div
        onDragOver={onZoneOver}
        onDragLeave={onZoneLeave}
        onDrop={onZoneDrop}
        className={`mb-3 rounded-md border-2 border-dashed p-4 text-center text-sm transition ${
          dropZoneHot
            ? 'border-brand-500 bg-brand-50 text-brand-900'
            : 'border-slate-300 text-slate-500'
        }`}
        aria-label="Drop images here to upload"
        data-testid="gallery-dropzone"
      >
        Drag and drop product photos here, or click <strong>+ Upload images</strong> above.
        {remaining === 0 && <p className="mt-1 text-[11px] text-amber-700">Gallery is at the configured maximum ({maxCap}). Remove one before uploading another.</p>}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">No images yet. Upload at least one — the first upload becomes the primary image automatically.</p>
      ) : (
        <ul role="list" className="space-y-2" onDragLeave={onDragLeave} data-testid="gallery-list">
          {items.map((image, idx) => {
            const hot = dragHoverId === image.id && dragId !== image.id;
            return (
              <li
                key={image.id}
                draggable
                onDragStart={(e) => onDragStart(e, image.id)}
                onDragOver={(e) => onDragOver(e, image.id)}
                onDrop={(e) => onDrop(e, image.id)}
                onDragEnd={onDragEnd}
                className={`flex flex-wrap items-center gap-3 rounded-md border p-2 ${hot ? 'border-brand-500 bg-brand-50' : 'border-slate-200'} ${dragId === image.id ? 'opacity-60' : ''}`}
                data-testid="gallery-row"
                data-image-id={image.id}
              >
                <span aria-hidden="true" className="cursor-grab select-none text-slate-400" title="Drag to reorder">⋮⋮</span>
                <div className="flex flex-col gap-1">
                  <div className="flex gap-1">
                    <button type="button" aria-label="Move image up"
                      onClick={() => move(image, -1)} disabled={busy !== 'idle' || idx === 0}
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 hover:bg-slate-50">↑</button>
                    <button type="button" aria-label="Move image down"
                      onClick={() => move(image, +1)} disabled={busy !== 'idle' || idx === items.length - 1}
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 hover:bg-slate-50">↓</button>
                  </div>
                  <span className="text-[10px] text-slate-400">#{image.sortOrder}</span>
                </div>
                <a href={image.url} target="_blank" rel="noopener noreferrer" className="block h-16 w-16 overflow-hidden rounded-md bg-slate-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt={image.alt ?? productName} className="h-full w-full object-cover" />
                </a>
                <div className="flex-1 min-w-[12rem]">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Alt text</label>
                  <AltEditor image={image} onSave={(v) => saveAlt(image, v)} />
                  <p className="mt-1 truncate text-[10px] font-mono text-slate-400" title={image.url}>{image.url}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {image.isPrimary
                    ? <StatusBadge s="PRIMARY" />
                    : <button type="button" onClick={() => setPrimary(image)} disabled={busy !== 'idle' || !image.isActive}
                        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold hover:bg-amber-50">Set primary</button>}
                  <StatusBadge s={image.isActive ? 'ACTIVE' : 'DISABLED'} />
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => toggleActive(image)} disabled={busy !== 'idle'}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50">
                    {image.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" onClick={() => deleteRow(image)} disabled={busy !== 'idle'}
                    className="rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50">
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ── Inline alt-text editor (controlled, blur-or-Enter saves) ──────────
function AltEditor({ image, onSave }: { image: GalleryImage; onSave: (v: string) => void | Promise<void> }) {
  const [val, setVal] = useState(image.alt ?? '');
  useEffect(() => { setVal(image.alt ?? ''); }, [image.alt]);
  return (
    <input
      type="text"
      value={val}
      maxLength={200}
      onChange={(e) => setVal(e.currentTarget.value)}
      onBlur={() => { if (val !== (image.alt ?? '')) void onSave(val); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      placeholder="Describe this image for screen readers and SEO"
      aria-label="Alt text"
      className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
    />
  );
}

// ── Small helpers (multipart needs raw fetch + CSRF cookie) ────────────
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function fetchCsrf(): Promise<string | null> {
  try {
    await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    return readCookie('sc_csrf');
  } catch {
    return null;
  }
}
