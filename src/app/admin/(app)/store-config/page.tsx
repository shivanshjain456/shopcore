'use client';
/**
 * Store Config admin dashboard — Item 8 Phase 2.
 *
 * Schema-driven. The server returns `{ config, schema }`:
 *   - `config`: the current merged value tree (defaults + DB overrides)
 *   - `schema`: an array of `{ key, type, label, description, category,
 *     section, default, dangerLevel, requiresRestart, enumOptions }`
 *
 * This page builds the tabbed UI ENTIRELY from `schema` — adding a new
 * config entry on the server surfaces here without a UI edit. The
 * legacy `policies/hero/shipping/loyalty/b2b` nested sub-keys (which
 * pre-date the flat schema) are NOT in the schema response, so they
 * are not edited here; they continue to live under the older surface
 * (a thin "Legacy" tab if needed in a future revision).
 *
 * UX guarantees from the spec:
 *   - Per-tab + global unsaved-changes indicator (state hoisted to root).
 *   - Tab switch preserves edits.
 *   - Danger-level "danger" fields are disabled until "I understand".
 *   - JSON fields validated on blur with inline error.
 *   - Save loading + inline error display.
 *   - Export / Import / Reset all behind confirmation dialogs.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ChangeEvent, type FormEvent,
} from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import PhoneField from '@/components/forms/PhoneField';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import { isAdminImageKind } from '@/lib/uploads/imageKinds';

// ── Types (mirror the server response — kept local to avoid pulling
// server-only modules into a 'use client' file) ───────────────────────────

type ConfigType = 'boolean' | 'number' | 'string' | 'enum' | 'json';
type DangerLevel = 'safe' | 'caution' | 'danger';

type FieldHint = 'phone' | 'email' | 'url' | 'textarea';

interface SchemaRow {
  key:             string;
  type:            ConfigType;
  default:         unknown;
  label:           string;
  description:     string;
  category:        string;
  section:         string;
  dangerLevel:     DangerLevel | null;
  requiresRestart: boolean;
  enumOptions:     { value: string; label: string }[] | null;
  /** Item 9 — renderer hint. `'phone'` swaps the default text input for
   *  `<PhoneField>` (locked +91 prefix, digit-only). */
  fieldType:       FieldHint | null;
}

type ConfigShape = Record<string, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Walk a dot-path against the merged config object to get the current value. */
function readValue(config: ConfigShape, key: string): unknown {
  let cur: unknown = config;
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const CATEGORY_LABEL: Record<string, string> = {
  store:         'Store',
  features:      'Features',
  payments:      'Payments',
  shipping:      'Shipping',
  checkout:      'Checkout',
  loyalty:       'Loyalty',
  b2b:           'B2B',
  notifications: 'Notifications',
  security:      'Security',
  performance:   'Performance',
  maintenance:   'Maintenance',
};

// ── Main component ────────────────────────────────────────────────────────

export default function StoreConfigPage(): JSX.Element {
  const dialog = useDialog();

  const [schema, setSchema]       = useState<SchemaRow[]>([]);
  const [config, setConfig]       = useState<ConfigShape | null>(null);
  /** Pending edits — dot-key → new value. Cleared on successful save. */
  const [pending, setPending]     = useState<Record<string, unknown>>({});
  /** Inline validation errors from the server, dot-key → message. */
  const [errors, setErrors]       = useState<Record<string, string>>({});
  /** Per-field "I understand the risk" unlocks for danger-level fields. */
  const [unlocked, setUnlocked]   = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<string>('store');
  const [busy, setBusy]           = useState(false);
  const [bannerMsg, setBannerMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load ────────────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ config: ConfigShape; schema: SchemaRow[] }>(
        '/api/admin/store-config',
      );
      if (r.ok && r.data) {
        setSchema(r.data.schema);
        setConfig(r.data.config);
        setPending({});
        setErrors({});
      } else {
        setBannerMsg({ kind: 'err', text: r.error ?? 'Failed to load config.' });
      }
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const categoriesInOrder = useMemo(() => {
    // Order categories by their first appearance in the schema; this
    // matches the source-order in src/lib/storeConfig/schema.ts, which
    // is the most stable canonical ordering.
    const seen: string[] = [];
    for (const r of schema) if (!seen.includes(r.category)) seen.push(r.category);
    return seen;
  }, [schema]);

  // Switch tab if the current one disappears (after a load).
  useEffect(() => {
    if (categoriesInOrder.length > 0 && !categoriesInOrder.includes(activeTab)) {
      setActiveTab(categoriesInOrder[0]);
    }
  }, [categoriesInOrder, activeTab]);

  // ── Derived state ───────────────────────────────────────────────────
  const pendingKeys  = Object.keys(pending);
  const hasUnsaved   = pendingKeys.length > 0;
  const tabsWithPending = useMemo(() => {
    const set = new Set<string>();
    for (const k of pendingKeys) {
      const row = schema.find((s) => s.key === k);
      if (row) set.add(row.category);
    }
    return set;
  }, [pendingKeys, schema]);

  const inMaintenance = !!(config && readValue(config, 'maintenance.maintenanceMode') === true);

  // ── Field interaction helpers ───────────────────────────────────────
  const setField = useCallback((key: string, value: unknown) => {
    setPending((prev) => {
      const next = { ...prev, [key]: value };
      // If user re-typed the original value, drop it from pending.
      if (config && JSON.stringify(value) === JSON.stringify(readValue(config, key))) {
        delete next[key];
      }
      return next;
    });
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, [config]);

  const unlockDanger = useCallback(async (key: string) => {
    const ok = await dialog.confirm({
      title: 'Confirm risky change',
      message:
        `"${key}" is flagged as a high-risk setting. Changing it can affect customer access or platform security. Continue?`,
      intent: 'destructive',
      confirmLabel: 'I understand the risk',
    });
    if (ok) setUnlocked((prev) => ({ ...prev, [key]: true }));
  }, [dialog]);

  // ── Save ────────────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    if (!hasUnsaved) return;
    setBusy(true);
    setBannerMsg(null);
    try {
      const r = await api<{ config: ConfigShape; changedKeys: string[] }>(
        '/api/admin/store-config',
        { method: 'PATCH', body: { changes: pending } },
      );
      if (r.ok && r.data) {
        setConfig(r.data.config);
        setPending({});
        setErrors({});
        setUnlocked({});
        setBannerMsg({
          kind: 'ok',
          text: `Saved ${r.data.changedKeys.length} setting(s).`,
        });
        // Auto-clear banner after 3s.
        setTimeout(() => setBannerMsg(null), 3000);
      } else {
        // Surface per-field errors from VALIDATION_ERROR responses.
        const errMap: Record<string, string> = {};
        if (Array.isArray(r.issues)) {
          for (const i of r.issues) errMap[i.path] = i.message;
        }
        setErrors(errMap);
        setBannerMsg({ kind: 'err', text: r.error ?? 'Save failed.' });
      }
    } finally {
      setBusy(false);
    }
  }, [hasUnsaved, pending]);

  // ── Export ──────────────────────────────────────────────────────────
  const onExport = useCallback(async () => {
    // Use a raw fetch — the api() helper assumes JSON response.
    setBusy(true);
    try {
      const res = await fetch('/api/admin/store-config/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': getCookie('sc_csrf') ?? '' },
      });
      if (!res.ok) {
        await dialog.alert({ title: 'Export failed', message: `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = (res.headers.get('content-disposition') ?? '')
        .match(/filename="([^"]+)"/)?.[1] ?? `shopcore-config-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }, [dialog]);

  // ── Import ──────────────────────────────────────────────────────────
  const onImportFile = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch {
        await dialog.alert({ title: 'Import failed', message: 'File is not valid JSON.' });
        return;
      }
      // Phase A: preview
      const prev = await api<{ preview: boolean; diff: Array<{ key: string; before: unknown; after: unknown }> }>(
        '/api/admin/store-config/import',
        { method: 'POST', body: { config: parsed } },
      );
      if (!prev.ok || !prev.data) {
        await dialog.alert({ title: 'Import failed', message: prev.error ?? 'Preview failed.' });
        return;
      }
      if (prev.data.diff.length === 0) {
        await dialog.alert({ title: 'Nothing to import', message: 'The uploaded config matches the current settings.' });
        return;
      }
      const ok = await dialog.confirm({
        title: `Apply ${prev.data.diff.length} change(s)?`,
        message:
          `This will overwrite ${prev.data.diff.length} setting(s). Review the diff below.\n\n` +
          prev.data.diff.slice(0, 12).map((d) =>
            `${d.key}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
          ).join('\n') +
          (prev.data.diff.length > 12 ? `\n…and ${prev.data.diff.length - 12} more.` : ''),
        confirmLabel: 'Apply',
        intent: 'warning',
      });
      if (!ok) return;
      // Phase B: apply
      const ap = await api<{ config: ConfigShape }>('/api/admin/store-config/import',
        { method: 'POST', body: { config: parsed, confirmed: true } });
      if (ap.ok && ap.data) {
        setConfig(ap.data.config);
        setPending({});
        setErrors({});
        setBannerMsg({ kind: 'ok', text: 'Config imported successfully.' });
      } else {
        await dialog.alert({ title: 'Import apply failed', message: ap.error ?? 'Apply failed.' });
      }
    } finally {
      setBusy(false);
    }
  }, [dialog]);

  // ── Reset ───────────────────────────────────────────────────────────
  const onReset = useCallback(async () => {
    const typed = await dialog.promptUser({
      title: '⚠ Reset all settings to defaults?',
      message:
        'This will discard every customisation in store-config and replace it with the schema defaults. ' +
        'Audit log records the full before state so you can restore from an export. ' +
        'Type RESET_ALL_CONFIG to confirm.',
      intent: 'destructive',
      confirmLabel: 'Reset',
      inputType: 'text',
      placeholder: 'RESET_ALL_CONFIG',
    });
    if (typed !== 'RESET_ALL_CONFIG') {
      if (typed !== null) {
        await dialog.alert({ title: 'Reset cancelled', message: 'Confirmation string did not match.' });
      }
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ config: ConfigShape }>('/api/admin/store-config/reset',
        { method: 'POST', body: { confirm: 'RESET_ALL_CONFIG' } });
      if (r.ok && r.data) {
        setConfig(r.data.config);
        setPending({});
        setErrors({});
        setUnlocked({});
        setBannerMsg({ kind: 'ok', text: 'All settings reset to defaults.' });
      } else {
        await dialog.alert({ title: 'Reset failed', message: r.error ?? 'Reset failed.' });
      }
    } finally {
      setBusy(false);
    }
  }, [dialog]);

  // ── Render ──────────────────────────────────────────────────────────
  if (!config) {
    return (
      <>
        <PageHeader title="Store config" subtitle="Loading…" />
        <Card><p className="text-sm text-slate-500">Loading configuration…</p></Card>
      </>
    );
  }

  // Group active-tab rows by section.
  const activeRows = schema.filter((r) => r.category === activeTab);
  const sectionMap = new Map<string, SchemaRow[]>();
  for (const r of activeRows) {
    if (!sectionMap.has(r.section)) sectionMap.set(r.section, []);
    sectionMap.get(r.section)!.push(r);
  }

  return (
    <>
      <PageHeader
        title="Store config"
        subtitle="Granular control over every admin-tunable platform setting."
        actions={
          <>
            <Button tone="ghost" onClick={() => void onExport()} disabled={busy}>
              Export
            </Button>
            <Button tone="ghost" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              Import
            </Button>
            <input
              ref={fileInputRef} type="file" accept="application/json" className="hidden"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
                e.target.value = '';
              }}
            />
            <Button tone="danger" onClick={() => void onReset()} disabled={busy}>
              Reset to defaults
            </Button>
            <Button
              tone="primary"
              onClick={() => void onSave()}
              disabled={!hasUnsaved || busy}
            >
              {busy ? 'Saving…' : `Save${hasUnsaved ? ` (${pendingKeys.length})` : ''}`}
            </Button>
          </>
        }
      />

      {inMaintenance && (
        <Card className="mb-3 border-red-300 bg-red-50">
          <p className="text-sm font-semibold text-red-800">
            ⚠ Store is currently in maintenance mode — customers cannot access the storefront.
          </p>
        </Card>
      )}

      {bannerMsg && (
        <Card className={`mb-3 ${bannerMsg.kind === 'ok' ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
          <p className={`text-sm ${bannerMsg.kind === 'ok' ? 'text-emerald-800' : 'text-red-800'}`}>
            {bannerMsg.text}
          </p>
        </Card>
      )}

      {hasUnsaved && (
        <Card className="mb-3 border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">
            <strong>{pendingKeys.length} unsaved change(s).</strong>{' '}
            Switch tabs freely — your edits are preserved until you save.
          </p>
        </Card>
      )}

      {/* ── Tab bar ────────────────────────────────────────────── */}
      <div className="mb-4 sticky top-0 z-10 -mx-3 bg-slate-50/95 px-3 pt-1 pb-2 backdrop-blur">
        <div className="flex flex-wrap gap-1">
          {categoriesInOrder.map((cat) => {
            const dirty = tabsWithPending.has(cat);
            return (
              <button
                key={cat}
                onClick={() => setActiveTab(cat)}
                className={`tap-target rounded-md px-3 py-1.5 text-xs font-semibold ${
                  cat === activeTab
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                {CATEGORY_LABEL[cat] ?? cat}
                {dirty && <span className="ml-1 text-amber-400">●</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Active tab content ──────────────────────────────────── */}
      {Array.from(sectionMap.entries()).map(([section, rows]) => (
        <Card key={section} className="mb-3">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">{section}</h3>
          <div className="space-y-3">
            {rows.map((row) => (
              <FieldRow
                key={row.key}
                row={row}
                value={
                  row.key in pending
                    ? pending[row.key]
                    : readValue(config, row.key)
                }
                error={errors[row.key]}
                unlocked={unlocked[row.key] === true}
                onChange={(v) => setField(row.key, v)}
                onUnlock={() => void unlockDanger(row.key)}
                isPending={row.key in pending}
              />
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

// ── Per-field renderer (one component per type) ───────────────────────────

interface FieldRowProps {
  row:       SchemaRow;
  value:     unknown;
  error?:    string;
  unlocked:  boolean;
  isPending: boolean;
  onChange:  (v: unknown) => void;
  onUnlock:  () => void;
}

function FieldRow({ row, value, error, unlocked, isPending, onChange, onUnlock }: FieldRowProps): JSX.Element {
  const disabledByDanger = row.dangerLevel === 'danger' && !unlocked;
  const dangerBadge =
    row.dangerLevel === 'danger'  ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">Danger</span>
  : row.dangerLevel === 'caution' ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">Caution</span>
  : null;
  const restartBadge = row.requiresRestart
    ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-700">Requires restart</span>
    : null;

  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-white p-3 sm:grid-cols-[2fr_3fr]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm font-semibold text-slate-900" htmlFor={`f_${row.key}`}>
            {row.label}
          </label>
          {dangerBadge}
          {restartBadge}
          {isPending && <span className="text-[10px] font-bold uppercase text-amber-600">● Unsaved</span>}
        </div>
        <p className="mt-1 text-xs text-slate-600">{row.description}</p>
        <p className="mt-1 font-mono text-[10px] text-slate-400">{row.key}</p>
      </div>
      <div>
        {disabledByDanger ? (
          <Button tone="danger" onClick={onUnlock}>I understand — unlock</Button>
        ) : (
          <FieldInput row={row} value={value} onChange={onChange} />
        )}
        {error && <p className="mt-1 text-xs font-semibold text-red-700">{error}</p>}
      </div>
    </div>
  );
}

function FieldInput({ row, value, onChange }: {
  row: SchemaRow; value: unknown; onChange: (v: unknown) => void;
}): JSX.Element {
  const inputClass =
    'block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';

  // Item 9 — fieldType: 'phone' renderer override. Schema marks
  // `store.supportPhone` (and any future phone entry) with this hint;
  // we swap in <PhoneField> for the locked +91 / digit-only UX. The
  // PhoneField always emits the full E.164 string (or empty string),
  // which is what the schema's validator expects.
  if (row.type === 'string' && row.fieldType === 'phone') {
    return (
      <PhoneField
        id={`f_${row.key}`}
        label=""                   // outer FieldRow already renders the label
        value={typeof value === 'string' ? value : ''}
        onChange={(e164) => {
          // Treat an empty national-number entry as empty string so
          // optional phone entries (store.supportPhone) save cleanly.
          onChange(e164 === '+91' ? '' : e164);
        }}
      />
    );
  }

  // Item 17 — fieldType: 'image:<kind>' renderer override.
  //   Swap the plain text input for <ImageUploadInput> bound to the
  //   matching upload kind (logo / favicon / og_image / app_icon /
  //   brand / category / ...). The component still emits a plain
  //   string URL on change, so the schema's `str` validator continues
  //   to apply unchanged.
  if (row.type === 'string' && typeof row.fieldType === 'string' && row.fieldType.startsWith('image:')) {
    const kindRaw = row.fieldType.slice('image:'.length);
    if (isAdminImageKind(kindRaw)) {
      return (
        <ImageUploadInput
          name={`f_${row.key}`}
          kind={kindRaw}
          value={typeof value === 'string' ? value : ''}
          onChange={(url) => onChange(url)}
          label=""
        />
      );
    }
  }

  if (row.type === 'boolean') {
    const checked = value === true;
    return (
      <label className="inline-flex items-center gap-2">
        <input
          id={`f_${row.key}`}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="tap-target h-5 w-9 cursor-pointer appearance-none rounded-full bg-slate-300 transition-colors checked:bg-emerald-500"
        />
        <span className="text-xs text-slate-600">{checked ? 'On' : 'Off'}</span>
      </label>
    );
  }
  if (row.type === 'number') {
    return (
      <input
        id={`f_${row.key}`}
        type="number"
        value={typeof value === 'number' ? value : Number(value) || 0}
        onChange={(e) => {
          const n = e.target.value === '' ? 0 : Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className={inputClass}
      />
    );
  }
  if (row.type === 'enum') {
    return (
      <select
        id={`f_${row.key}`}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} bg-white`}
      >
        {(row.enumOptions ?? []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  if (row.type === 'json') {
    return <JsonField row={row} value={value} onChange={onChange} />;
  }
  // string fallback
  return (
    <input
      id={`f_${row.key}`}
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  );
}

function JsonField({ row, value, onChange }: {
  row: SchemaRow; value: unknown; onChange: (v: unknown) => void;
}): JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(value ?? row.default, null, 2));
  const [error, setError] = useState<string | null>(null);
  // Re-sync the text area when the controlled `value` changes externally
  // (e.g. after Save → reload).
  useEffect(() => {
    setText(JSON.stringify(value ?? row.default, null, 2));
    setError(null);
  }, [value, row.default]);

  return (
    <div>
      <textarea
        id={`f_${row.key}`}
        rows={4}
        value={text}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        onBlur={(e: FormEvent<HTMLTextAreaElement>) => {
          const t = (e.target as HTMLTextAreaElement).value;
          try {
            const parsed = JSON.parse(t);
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError(`Invalid JSON: ${(err as Error).message}`);
          }
        }}
        className="block w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {error && <p className="mt-1 text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}

// ── Tiny cookie reader (avoids depending on lib/client/api internals) ─────
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
