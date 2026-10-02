'use client';
/**
 * BranchesTab — Item 18 Phase 2.
 *
 *   CRUD for HomepageBranch rows. Used by the BRANCHES section.
 */
import React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Button, Card, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import { TextField, TextareaField, NumberField } from './forms/sharedInputs';

interface BranchRow {
  id:           string;
  name:         string;
  city:         string;
  address:      string | null;
  phone:        string | null;
  imageUrl:     string | null;
  linkUrl:      string | null;
  displayOrder: number;
  isActive:     boolean;
}

interface Draft {
  id?:          string;
  name:         string;
  city:         string;
  address:      string;
  phone:        string;
  imageUrl:     string;
  linkUrl:      string;
  displayOrder: number;
  isActive:     boolean;
}
const EMPTY: Draft = { name: '', city: '', address: '', phone: '', imageUrl: '', linkUrl: '', displayOrder: 10, isActive: true };

export default function BranchesTab() {
  const dialog = useDialog();
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await api<{ items: BranchRow[] }>('/api/admin/homepage/branches');
    setBusy(false);
    if (r.ok && r.data) setRows(r.data.items);
    else setError(r.error ?? 'Could not load branches.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    const body = {
      name:         draft.name.trim(),
      city:         draft.city.trim(),
      address:      draft.address.trim() || null,
      phone:        draft.phone.trim()   || null,
      imageUrl:     draft.imageUrl.trim() || null,
      linkUrl:      draft.linkUrl.trim() || null,
      displayOrder: draft.displayOrder,
      isActive:     draft.isActive,
    };
    const path = draft.id ? `/api/admin/homepage/branches/${draft.id}` : '/api/admin/homepage/branches';
    const r = await api(path, { method: draft.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Save failed.'); return; }
    setDraft(null);
    await load();
  }

  async function remove(row: BranchRow) {
    const ok = await dialog.confirm({
      title: 'Delete branch?',
      message: `"${row.name}" will be removed. This cannot be undone.`,
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy(true);
    const r = await api(`/api/admin/homepage/branches/${row.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Delete failed', message: r.error ?? '' }); return; }
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Branches appear in any section of kind <strong>Store branches</strong>.
        </p>
        <Button
          type="button"
          onClick={() => setDraft({ ...EMPTY, displayOrder: rows.length > 0 ? Math.max(...rows.map((r) => r.displayOrder)) + 10 : 10 })}
          disabled={busy}
        >+ Add branch</Button>
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {draft && (
        <Card>
          <h3 className="text-sm font-semibold text-slate-800">{draft.id ? 'Edit branch' : 'New branch'}</h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label="Name" value={draft.name} maxLength={120} required
              onChange={(v) => setDraft({ ...draft, name: v })} />
            <TextField label="City" value={draft.city} maxLength={80} required
              onChange={(v) => setDraft({ ...draft, city: v })} />
            <TextField label="Phone (optional)" value={draft.phone} maxLength={40}
              onChange={(v) => setDraft({ ...draft, phone: v })} />
            <NumberField label="Display order" min={0} step={10} value={draft.displayOrder}
              onChange={(n) => setDraft({ ...draft, displayOrder: Math.max(0, n) })} />
          </div>
          <div className="mt-3">
            <TextareaField label="Address (optional)" value={draft.address} maxLength={400}
              onChange={(v) => setDraft({ ...draft, address: v })} />
          </div>
          <div className="mt-3">
            <TextField label="Map / details URL (optional)" value={draft.linkUrl} maxLength={500}
              onChange={(v) => setDraft({ ...draft, linkUrl: v })} />
          </div>
          <div className="mt-3">
            <ImageUploadInput
              name={`branch-image-${draft.id ?? 'new'}`}
              kind="misc"
              label="Storefront photo (optional)"
              value={draft.imageUrl}
              onChange={(v) => setDraft({ ...draft, imageUrl: v })}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
              Active
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button tone="ghost" type="button" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button>
            <Button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </Card>
      )}

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No branches yet. Click <strong>+ Add branch</strong>.</p>
        ) : (
          <ul role="list" className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 p-3">
                {row.imageUrl
                  ? <span className="inline-block h-12 w-16 overflow-hidden rounded-md bg-slate-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={row.imageUrl} alt={`${row.name} storefront`} className="h-full w-full object-cover" />
                    </span>
                  : <span aria-hidden="true" className="inline-block h-12 w-16 rounded-md bg-slate-100" />}
                <div className="flex-1 min-w-[10rem]">
                  <p className="text-sm font-semibold text-slate-900">{row.name}</p>
                  <p className="text-[11px] text-slate-500">{row.city}{row.phone ? ` · ${row.phone}` : ''}</p>
                  {row.address && <p className="text-[11px] text-slate-500">{row.address}</p>}
                </div>
                <span className="text-[10px] text-slate-400">#{row.displayOrder}</span>
                <StatusBadge s={row.isActive ? 'ACTIVE' : 'DISABLED'} />
                <div className="flex gap-1">
                  <Button tone="ghost" type="button" onClick={() => setDraft({
                    id: row.id, name: row.name, city: row.city,
                    address: row.address ?? '', phone: row.phone ?? '',
                    imageUrl: row.imageUrl ?? '', linkUrl: row.linkUrl ?? '',
                    displayOrder: row.displayOrder, isActive: row.isActive,
                  })} disabled={busy}>Edit</Button>
                  <Button tone="danger" type="button" onClick={() => remove(row)} disabled={busy}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
