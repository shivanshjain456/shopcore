'use client';
/**
 * MetricsTab — Item 18 Phase 2.
 *
 *   CRUD for HomepageMetric rows. Used by the STORE_METRICS section.
 *   Per row: label · value · caption · icon URL · displayOrder · active.
 */
import React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Button, Card, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import { TextField, NumberField } from './forms/sharedInputs';

interface MetricRow {
  id:           string;
  label:        string;
  value:        string;
  caption:      string | null;
  iconUrl:      string | null;
  displayOrder: number;
  isActive:     boolean;
}

interface Draft {
  id?:          string;
  label:        string;
  value:        string;
  caption:      string;
  iconUrl:      string;
  displayOrder: number;
  isActive:     boolean;
}
const EMPTY_DRAFT: Draft = { label: '', value: '', caption: '', iconUrl: '', displayOrder: 10, isActive: true };

export default function MetricsTab() {
  const dialog = useDialog();
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await api<{ items: MetricRow[] }>('/api/admin/homepage/metrics');
    setBusy(false);
    if (r.ok && r.data) setRows(r.data.items);
    else setError(r.error ?? 'Could not load metrics.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    const body = {
      label:        draft.label.trim(),
      value:        draft.value.trim(),
      caption:      draft.caption.trim() || null,
      iconUrl:      draft.iconUrl.trim() || null,
      displayOrder: draft.displayOrder,
      isActive:     draft.isActive,
    };
    const path = draft.id ? `/api/admin/homepage/metrics/${draft.id}` : '/api/admin/homepage/metrics';
    const r = await api(path, { method: draft.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Save failed.'); return; }
    setDraft(null);
    await load();
  }

  async function remove(row: MetricRow) {
    const ok = await dialog.confirm({
      title: 'Delete metric?',
      message: `"${row.label}" will be removed. This cannot be undone.`,
      intent: 'destructive', confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy(true);
    const r = await api(`/api/admin/homepage/metrics/${row.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Delete failed', message: r.error ?? '' }); return; }
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-600">
          Metric tiles surface in any section of kind <strong>Store metrics</strong>.
        </p>
        <Button
          type="button"
          onClick={() => setDraft({ ...EMPTY_DRAFT, displayOrder: rows.length > 0 ? Math.max(...rows.map((r) => r.displayOrder)) + 10 : 10 })}
          disabled={busy}
        >+ Add metric</Button>
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {draft && (
        <Card>
          <h3 className="text-sm font-semibold text-slate-800">{draft.id ? 'Edit metric' : 'New metric'}</h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label="Label" value={draft.label} maxLength={120} required
              onChange={(v) => setDraft({ ...draft, label: v })} />
            <TextField label="Value (display)" value={draft.value} maxLength={60} required
              hint="e.g. 170+ · 10M+ · 1000+"
              onChange={(v) => setDraft({ ...draft, value: v })} />
            <TextField label="Caption (optional)" value={draft.caption} maxLength={240}
              onChange={(v) => setDraft({ ...draft, caption: v })} />
            <NumberField label="Display order" min={0} step={10} value={draft.displayOrder}
              onChange={(n) => setDraft({ ...draft, displayOrder: Math.max(0, n) })} />
          </div>
          <div className="mt-3">
            <ImageUploadInput
              name={`metric-icon-${draft.id ?? 'new'}`}
              kind="misc"
              label="Icon (optional)"
              value={draft.iconUrl}
              onChange={(v) => setDraft({ ...draft, iconUrl: v })}
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
          <p className="p-4 text-sm text-slate-500">No metrics yet. Click <strong>+ Add metric</strong>.</p>
        ) : (
          <ul role="list" className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 p-3">
                {row.iconUrl
                  ? <span className="inline-block h-9 w-9 overflow-hidden rounded-md bg-slate-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={row.iconUrl} alt="" className="h-full w-full object-contain" />
                    </span>
                  : <span aria-hidden="true" className="inline-block h-9 w-9 rounded-md bg-slate-100" />}
                <div className="flex-1 min-w-[10rem]">
                  <p className="text-sm font-semibold text-slate-900">
                    {row.value}
                    <span className="ml-2 text-xs font-normal text-slate-500">{row.label}</span>
                  </p>
                  {row.caption && <p className="text-[11px] text-slate-500">{row.caption}</p>}
                </div>
                <span className="text-[10px] text-slate-400">#{row.displayOrder}</span>
                <StatusBadge s={row.isActive ? 'ACTIVE' : 'DISABLED'} />
                <div className="flex gap-1">
                  <Button tone="ghost" type="button" onClick={() => setDraft({
                    id: row.id, label: row.label, value: row.value,
                    caption: row.caption ?? '', iconUrl: row.iconUrl ?? '',
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
