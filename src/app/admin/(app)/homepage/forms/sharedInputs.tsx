'use client';
/**
 * Shared form inputs for the homepage CMS — Item 18 Phase 2.
 *
 *   - <TextField>    — labelled <input>
 *   - <TextareaField>— labelled <textarea>
 *   - <SelectField>  — labelled <select>
 *   - <NumberField>  — labelled numeric input
 *   - <CtaPair>      — { label, href } sub-form, controlled
 *   - <ThemePicker>  — radio chips for the soft-bg theme enum
 *   - <SourcePicker> — radio: auto / manual
 *   - <ChipPicker>   — generic remote-list multi-select with search +
 *                       de-dup + drag-free reordering via ↑ / ↓
 *
 *   Every component is a controlled (no internal value-state) leaf so
 *   the parent owns the data and the registry can serialise it.
 */
import React from 'react';
import { ChangeEvent, KeyboardEvent, ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';

// ── Primitive labelled inputs ───────────────────────────────────────────

export function TextField({
  label, value, onChange, placeholder, maxLength, required, hint, id: customId,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; maxLength?: number; required?: boolean; hint?: string; id?: string;
}) {
  const fallback = useId();
  const id = customId ?? fallback;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
        {label}{required && <span className="text-red-600" aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
      />
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function TextareaField({
  label, value, onChange, placeholder, maxLength, rows = 3,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; rows?: number }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</label>
      <textarea
        id={id}
        value={value}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
      />
    </div>
  );
}

export function SelectField<T extends string>({
  label, value, options, onChange,
}: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as T)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export function NumberField({
  label, value, onChange, min, max, step = 1, hint,
}: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
      />
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

// ── CTA pair ────────────────────────────────────────────────────────────

export interface CtaValue { label: string; href: string }

export function CtaPair({
  label = 'Call to action', value, onChange,
}: { label?: string; value: CtaValue; onChange: (v: CtaValue) => void }) {
  return (
    <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</legend>
      <TextField label="Button label" value={value.label} maxLength={60}
        onChange={(label) => onChange({ ...value, label })}
        placeholder="See all" />
      <TextField label="Link URL" value={value.href} maxLength={500}
        onChange={(href) => onChange({ ...value, href })}
        placeholder="/search?sort=relevance" />
    </fieldset>
  );
}

// ── Theme picker ────────────────────────────────────────────────────────

export type ThemeName = 'default' | 'sky' | 'amber' | 'emerald' | 'rose' | 'slate';
const THEME_PALETTE: Array<{ value: ThemeName; bg: string; label: string }> = [
  { value: 'default',  bg: 'bg-white border-slate-300',  label: 'Default' },
  { value: 'sky',      bg: 'bg-sky-50',                  label: 'Sky' },
  { value: 'amber',    bg: 'bg-amber-50',                label: 'Amber' },
  { value: 'emerald',  bg: 'bg-emerald-50',              label: 'Emerald' },
  { value: 'rose',     bg: 'bg-rose-50',                 label: 'Rose' },
  { value: 'slate',    bg: 'bg-slate-100',               label: 'Slate' },
];

export function ThemePicker({ value, onChange }: { value: ThemeName; onChange: (v: ThemeName) => void }) {
  return (
    <div>
      <p className="block text-xs font-semibold uppercase tracking-wide text-slate-600">Background theme</p>
      <div role="radiogroup" aria-label="Background theme" className="mt-1 flex flex-wrap gap-2">
        {THEME_PALETTE.map((t) => {
          const active = value === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(t.value)}
              className={`tap-target inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold ${t.bg} ${active ? 'ring-2 ring-brand-500 border-brand-500' : 'border-slate-300'}`}
            >
              <span aria-hidden="true" className={`inline-block h-3 w-3 rounded-full ${t.bg} border border-slate-400`} />
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Source (auto / manual) ──────────────────────────────────────────────

export function SourcePicker({
  value, onChange, autoHint, manualHint,
}: { value: 'auto' | 'manual'; onChange: (v: 'auto' | 'manual') => void; autoHint?: string; manualHint?: string }) {
  return (
    <div>
      <p className="block text-xs font-semibold uppercase tracking-wide text-slate-600">Source</p>
      <div role="radiogroup" aria-label="Source" className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(['auto', 'manual'] as const).map((s) => {
          const active = value === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(s)}
              className={`rounded-md border p-3 text-left text-sm transition ${active ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white'}`}
            >
              <span className="block text-sm font-semibold capitalize">{s}</span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                {s === 'auto' ? (autoHint ?? 'Pick automatically.') : (manualHint ?? 'Pick a specific list below.')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Generic remote chip picker (brands / categories / products) ─────────

export interface ChipItem { id: string; label: string; sub?: string }

export function ChipPicker({
  label, value, onChange, fetchItems, max, idField = 'id',
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Fetches the candidate items (debounced search). Must return items
   *  matching `ChipItem`. */
  fetchItems: (q: string) => Promise<ChipItem[]>;
  max?: number;
  /** Reserved for future variants — currently informational only. */
  idField?: string;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ChipItem[]>([]);
  const [resolved, setResolved] = useState<Record<string, ChipItem>>({});
  const [busy, setBusy] = useState(false);

  // Debounced search.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const next = await fetchItems(q);
        if (!cancelled) setItems(next);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, fetchItems]);

  // Resolve labels for already-selected ids that aren't in the search
  // result (so chips render with the right name even when the search
  // query no longer matches).
  useEffect(() => {
    const missing = value.filter((id) => !resolved[id]);
    if (missing.length === 0) return;
    const found = items.filter((i) => missing.includes(i.id));
    if (found.length === 0) return;
    const next: Record<string, ChipItem> = { ...resolved };
    for (const f of found) next[f.id] = f;
    setResolved(next);
  }, [items, value, resolved]);

  function add(id: string) {
    if (value.includes(id)) return;
    if (max !== undefined && value.length >= max) return;
    onChange([...value, id]);
  }
  function remove(id: string) {
    onChange(value.filter((x) => x !== id));
  }
  function move(id: string, dir: -1 | 1) {
    const idx = value.indexOf(id);
    if (idx < 0) return;
    const nxt = value.slice();
    const swap = idx + dir;
    if (swap < 0 || swap >= nxt.length) return;
    [nxt[idx], nxt[swap]] = [nxt[swap]!, nxt[idx]!];
    onChange(nxt);
  }

  // Visible items = search results that AREN'T already selected.
  const visible = useMemo(() => items.filter((i) => !value.includes(i.id)), [items, value]);

  return (
    <div>
      <p className="block text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</p>
      <div className="mt-1 space-y-2">
        {/* Selected chips with ↑ / ↓ + remove */}
        {value.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {value.map((id) => {
              const r = resolved[id] ?? items.find((x) => x.id === id);
              return (
                <li key={id} className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-1 pl-3 pr-1 text-xs text-brand-900">
                  <span className="font-semibold">{r?.label ?? id}</span>
                  <button type="button" aria-label="Move up" onClick={() => move(id, -1)} className="ml-1 rounded p-1 hover:bg-brand-100">↑</button>
                  <button type="button" aria-label="Move down" onClick={() => move(id, +1)} className="rounded p-1 hover:bg-brand-100">↓</button>
                  <button type="button" aria-label="Remove" onClick={() => remove(id)} className="rounded p-1 text-red-600 hover:bg-red-50">✕</button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">No items selected.</p>
        )}

        {/* Search + add */}
        <div>
          <label className="sr-only" htmlFor={`${label}-search`}>{label} search</label>
          <input
            id={`${label}-search`}
            type="search"
            value={q}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.currentTarget.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') { e.preventDefault(); if (visible[0]) add(visible[0].id); }
            }}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          {(max !== undefined) && (
            <p className="mt-1 text-[11px] text-slate-500">{value.length} / {max} selected.</p>
          )}
        </div>

        {busy ? (
          <p className="text-xs text-slate-500">Searching…</p>
        ) : visible.length > 0 ? (
          <ul className="max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white">
            {visible.slice(0, 20).map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => add(it.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span>
                    <span className="font-semibold text-slate-900">{it.label}</span>
                    {it.sub && <span className="ml-1 text-xs text-slate-500">{it.sub}</span>}
                  </span>
                  <span aria-hidden="true" className="text-xs text-brand-700">+ Add</span>
                </button>
              </li>
            ))}
          </ul>
        ) : q.length > 0 ? (
          <p className="text-xs text-slate-500">No matches.</p>
        ) : null}
      </div>
    </div>
  );
}

// ── Concrete fetchers wired to existing admin GET endpoints ─────────────

interface BrandRow { id: string; name: string; slug: string }
interface CategoryRow { id: string; name: string; slug: string }
interface ProductRow { id: string; name: string; sku: string; slug: string }

export async function searchBrands(q: string): Promise<ChipItem[]> {
  const r = await api<{ items: BrandRow[] }>(`/api/admin/brands?pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  if (!r.ok || !r.data) return [];
  const all = r.data.items;
  const filtered = q ? all.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()) || b.slug.toLowerCase().includes(q.toLowerCase())) : all;
  return filtered.map((b) => ({ id: b.id, label: b.name, sub: b.slug }));
}
export async function searchCategories(q: string): Promise<ChipItem[]> {
  const r = await api<{ items: CategoryRow[] }>(`/api/admin/categories?pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  if (!r.ok || !r.data) return [];
  const all = r.data.items;
  const filtered = q ? all.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.slug.toLowerCase().includes(q.toLowerCase())) : all;
  return filtered.map((c) => ({ id: c.id, label: c.name, sub: c.slug }));
}
export async function searchProducts(q: string): Promise<ChipItem[]> {
  const r = await api<{ items: ProductRow[] }>(`/api/admin/products?pageSize=30${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  if (!r.ok || !r.data) return [];
  return r.data.items.map((p) => ({ id: p.id, label: p.name, sub: p.sku }));
}

// ── Wrapper helpers (read existing config with defensive defaults) ──────

export function pickString(o: Record<string, unknown>, k: string, fallback = ''): string {
  const v = o[k];
  return typeof v === 'string' ? v : fallback;
}
export function pickNumber(o: Record<string, unknown>, k: string, fallback: number): number {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export function pickBool(o: Record<string, unknown>, k: string, fallback: boolean): boolean {
  const v = o[k];
  return typeof v === 'boolean' ? v : fallback;
}
export function pickStringArray(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
export function pickObject(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = o[k];
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

export function asCta(o: Record<string, unknown>, k: string): CtaValue {
  const v = pickObject(o, k);
  return { label: pickString(v, 'label', ''), href: pickString(v, 'href', '') };
}

export function asTheme(o: Record<string, unknown>, k: string): ThemeName {
  const v = pickString(o, k, 'default');
  return (['default', 'sky', 'amber', 'emerald', 'rose', 'slate'] as const).includes(v as ThemeName)
    ? (v as ThemeName) : 'default';
}

// ── Section heading wrapper ─────────────────────────────────────────────

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
