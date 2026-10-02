'use client';
/**
 * SectionsTab — Item 18 Phase 2.
 *
 *   Lists every homepage section. Per row:
 *     - drag handle (HTML5 native — no DnD library)
 *     - ↑ / ↓ buttons (keyboard + screen-reader accessible alternative)
 *     - kind + slug + display order + active badge
 *     - Edit / Disable-Enable / Delete
 *
 *   Above the list:
 *     - "+ Add section" → opens the kind picker, then the editor pane.
 *     - "Preview" → opens `/?preview=admin` in a new tab.
 *
 *   Every mutation talks to /api/admin/homepage/* and re-loads the list
 *   so the UI never shows stale data.
 */
import React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { Button, Card, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import SectionEditor, { type SectionDraft } from './SectionEditor';
import { SECTION_KIND_LABELS } from './forms/sectionFormRegistry';
import type { HomepageSectionKind } from '@/lib/cms/homepageSchemas';

interface SectionRow {
  id:           string;
  kind:         string;
  slug:         string;
  title:        string | null;
  displayOrder: number;
  isActive:     boolean;
  startsAt:     string | null;
  endsAt:       string | null;
  config:       Record<string, unknown>;
  createdAt:    string;
  updatedAt:    string;
}

interface ListResponse {
  items: SectionRow[];
  availableKinds: HomepageSectionKind[];
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocal(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function asKind(k: string): HomepageSectionKind | null {
  return SECTION_KIND_LABELS[k as HomepageSectionKind] ? (k as HomepageSectionKind) : null;
}

export default function SectionsTab() {
  const dialog = useDialog();
  const [rows, setRows]               = useState<SectionRow[]>([]);
  const [availableKinds, setKinds]    = useState<HomepageSectionKind[]>([]);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [draft, setDraft]             = useState<SectionDraft | null>(null);
  const [picking, setPicking]         = useState(false);
  const [dragId, setDragId]           = useState<string | null>(null);
  const [hoverId, setHoverId]         = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await api<ListResponse>('/api/admin/homepage/sections');
    setBusy(false);
    if (r.ok && r.data) {
      setRows(r.data.items.slice().sort((a, b) => a.displayOrder - b.displayOrder));
      setKinds(r.data.availableKinds);
    } else {
      setError(r.error ?? 'Could not load homepage sections.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate(kind: HomepageSectionKind) {
    setPicking(false);
    setError(null);
    setDraft({
      kind,
      meta: {
        slug:         '',
        title:        SECTION_KIND_LABELS[kind],
        displayOrder: rows.length > 0 ? Math.max(...rows.map((r) => r.displayOrder)) + 10 : 10,
        isActive:     true,
        startsAt:     '',
        endsAt:       '',
      },
      config: {},
    });
  }
  function openEdit(row: SectionRow) {
    const kind = asKind(row.kind);
    if (!kind) return;
    setError(null);
    setDraft({
      id:   row.id,
      kind,
      meta: {
        slug:         row.slug,
        title:        row.title ?? '',
        displayOrder: row.displayOrder,
        isActive:     row.isActive,
        startsAt:     toDatetimeLocal(row.startsAt),
        endsAt:       toDatetimeLocal(row.endsAt),
      },
      config: row.config,
    });
  }

  async function saveDraft(next: SectionDraft) {
    setBusy(true); setError(null);
    const body = {
      kind:         next.kind,
      slug:         next.meta.slug.trim().toLowerCase(),
      title:        next.meta.title.trim() || null,
      displayOrder: next.meta.displayOrder,
      isActive:     next.meta.isActive,
      startsAt:     fromDatetimeLocal(next.meta.startsAt),
      endsAt:       fromDatetimeLocal(next.meta.endsAt),
      config:       next.config,
    };
    const path = next.id ? `/api/admin/homepage/sections/${next.id}` : '/api/admin/homepage/sections';
    const r = await api<{ section: SectionRow }>(path, {
      method: next.id ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Could not save the section.');
      return;
    }
    setDraft(null);
    await load();
  }

  async function toggleActive(row: SectionRow) {
    setBusy(true);
    const r = await api(`/api/admin/homepage/sections/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    setBusy(false);
    if (!r.ok) {
      await dialog.alert({ title: 'Could not update', message: r.error ?? 'Try again.' });
      return;
    }
    await load();
  }

  async function deleteRow(row: SectionRow) {
    const ok = await dialog.confirm({
      title:   'Delete this section?',
      message: `"${row.title ?? row.slug}" will be removed from the homepage. This cannot be undone.`,
      intent:  'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy(true);
    const r = await api(`/api/admin/homepage/sections/${row.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!r.ok) {
      await dialog.alert({ title: 'Delete failed', message: r.error ?? 'Try again.' });
      return;
    }
    await load();
  }

  async function persistOrder(orderedIds: string[]) {
    setBusy(true);
    const r = await api('/api/admin/homepage/sections/reorder', {
      method: 'POST', body: JSON.stringify({ orderedIds }),
    });
    setBusy(false);
    if (!r.ok) {
      await dialog.alert({ title: 'Reorder failed', message: r.error ?? 'Try again.' });
    }
    await load();
  }

  async function moveBy(row: SectionRow, dir: -1 | 1) {
    const ids = rows.map((r) => r.id);
    const idx = ids.indexOf(row.id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap]!, ids[idx]!];
    // Optimistic local update.
    setRows(rows.slice().sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((r, i) => ({ ...r, displayOrder: (i + 1) * 10 })));
    await persistOrder(ids);
  }

  // ── Drag handlers ───────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent<HTMLLIElement>, id: string) {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
  function onDragOver(e: React.DragEvent<HTMLLIElement>, id: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (hoverId !== id) setHoverId(id);
  }
  function onDragLeave() { setHoverId(null); }
  async function onDrop(e: React.DragEvent<HTMLLIElement>, targetId: string) {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null); setHoverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(sourceId);
    const to   = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const reordered = ids.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    // Optimistic update.
    setRows(rows.slice().sort((a, b) => reordered.indexOf(a.id) - reordered.indexOf(b.id))
      .map((r, i) => ({ ...r, displayOrder: (i + 1) * 10 })));
    await persistOrder(reordered);
  }
  function onDragEnd() { setDragId(null); setHoverId(null); }

  const pickerOptions = useMemo(() => availableKinds.filter((k) => SECTION_KIND_LABELS[k]), [availableKinds]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          Drag rows to reorder. Hidden sections (toggled off) are excluded from the live storefront.
        </p>
        <div className="flex gap-2">
          <Link
            href="/?preview=admin"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Preview homepage
          </Link>
          <Button onClick={() => setPicking(true)} disabled={busy} type="button">+ Add section</Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {picking && (
        <Card className="border-dashed">
          <h3 className="text-sm font-semibold text-slate-800">Pick a section type</h3>
          <p className="mt-1 text-xs text-slate-500">Each type maps to one render block on the storefront.</p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pickerOptions.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => openCreate(k)}
                  className="block w-full rounded-md border border-slate-200 bg-white p-3 text-left text-sm hover:border-brand-400 hover:bg-brand-50"
                >
                  <span className="block text-sm font-semibold text-slate-900">{SECTION_KIND_LABELS[k]}</span>
                  <span className="mt-0.5 block text-[11px] font-mono text-slate-500">{k}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button tone="ghost" type="button" onClick={() => setPicking(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {draft && (
        <SectionEditor
          draft={draft}
          busy={busy}
          error={error}
          onCancel={() => { setDraft(null); setError(null); }}
          onSave={saveDraft}
        />
      )}

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No sections yet — click <strong>+ Add section</strong>.</p>
        ) : (
          <ul role="list" className="divide-y divide-slate-100" data-testid="hp-sections-list" onDragLeave={onDragLeave}>
            {rows.map((row, idx) => {
              const kindLabel = SECTION_KIND_LABELS[(row.kind as HomepageSectionKind)] ?? row.kind;
              const isHover = hoverId === row.id && dragId !== row.id;
              return (
                <li
                  key={row.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, row.id)}
                  onDragOver={(e) => onDragOver(e, row.id)}
                  onDrop={(e) => onDrop(e, row.id)}
                  onDragEnd={onDragEnd}
                  className={`flex flex-wrap items-center gap-3 p-3 ${isHover ? 'bg-brand-50' : ''} ${dragId === row.id ? 'opacity-60' : ''}`}
                  data-testid="hp-section-row"
                  data-section-id={row.id}
                >
                  <span
                    aria-hidden="true"
                    className="cursor-grab select-none text-slate-400"
                    title="Drag to reorder"
                  >⋮⋮</span>
                  <div className="flex flex-col gap-1">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Move ${row.slug} up`}
                        onClick={() => moveBy(row, -1)}
                        disabled={busy || idx === 0}
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 hover:bg-slate-50"
                      >↑</button>
                      <button
                        type="button"
                        aria-label={`Move ${row.slug} down`}
                        onClick={() => moveBy(row, +1)}
                        disabled={busy || idx === rows.length - 1}
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 hover:bg-slate-50"
                      >↓</button>
                    </div>
                    <span className="text-[10px] text-slate-400">#{row.displayOrder}</span>
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <p className="text-sm font-semibold text-slate-900">
                      {row.title ?? row.slug}
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600">{kindLabel}</span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      <span className="font-mono">/{row.slug}</span>
                      {row.startsAt && <span> · from {new Date(row.startsAt).toLocaleString()}</span>}
                      {row.endsAt   && <span> · until {new Date(row.endsAt).toLocaleString()}</span>}
                    </p>
                  </div>
                  <StatusBadge s={row.isActive ? 'ACTIVE' : 'DISABLED'} />
                  <div className="flex gap-1">
                    <Button tone="ghost" type="button" onClick={() => openEdit(row)} disabled={busy}>Edit</Button>
                    <Button tone="ghost" type="button" onClick={() => toggleActive(row)} disabled={busy}>
                      {row.isActive ? 'Disable' : 'Enable'}
                    </Button>
                    <Button tone="danger" type="button" onClick={() => deleteRow(row)} disabled={busy}>Delete</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
