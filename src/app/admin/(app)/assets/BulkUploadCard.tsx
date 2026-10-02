'use client';
/**
 * <BulkUploadCard> — Item 17 Phase 2.
 *
 *   File picker → filename→slug matching preview → admin confirms →
 *   sequential uploads + PATCH-style PUTs to write the URL onto the
 *   matched Brand or Category. All matching is pure / client-side
 *   (no server round-trip until confirm).
 *
 * Important: brands don't currently have a PATCH endpoint (Phase 1
 * shipped a POST-only brand admin); for now we POST a NEW brand only
 * if the slug doesn't exist, otherwise we surface "would update —
 * needs PATCH endpoint" as a per-file note. Categories have the same
 * Phase-1 limitation; the bulk-upload UI is therefore best for the
 * common case of "we already have brands without logos" — those rows
 * appear in the unmatched list and the admin assigns them manually
 * via dropdown (which we DO send as a brand.logoUrl on whatever
 * Brand row already exists — using a small dedicated endpoint).
 *
 * Rather than ship a Phase 1 brand PATCH endpoint here, the bulk
 * upload runs all files through /api/admin/uploads (which already
 * exists, audited + rate-limited) and returns the resulting URLs in
 * a result table for the admin to copy. The match preview is the
 * value-add — for actual one-click assign we need a future brand /
 * category PATCH endpoint (Phase 2.1).
 */
import { useMemo, useRef, useState } from 'react';
import { Card, Button } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';

/** Read a cookie value by name (CSRF-token lookup). */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
import {
  matchFilenamesToCandidates,
  type FilenameMatchResult, type MatchCandidate,
} from '@/lib/assets/filenameMatch';
import type { AdminImageKind } from '@/lib/uploads/imageKinds';

interface BrandRow    { id: string; name: string; slug: string }
interface CategoryRow { id: string; name: string; slug: string }

interface Props {
  brands:     readonly BrandRow[];
  categories: readonly CategoryRow[];
  onUploaded: () => void;
}

type BulkMode = 'brand' | 'category';

interface FileResult {
  match: FilenameMatchResult;
  state: 'pending' | 'uploading' | 'done' | 'error';
  url?:  string;
  err?:  string;
}

const KIND_FOR_MODE: Record<BulkMode, AdminImageKind> = {
  brand:    'brand',
  category: 'category',
};

export default function BulkUploadCard({ brands, categories, onUploaded }: Props) {
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode]       = useState<BulkMode>('brand');
  const [picked, setPicked]   = useState<File[]>([]);
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy]       = useState(false);

  const candidates: MatchCandidate[] = useMemo(
    () => (mode === 'brand' ? brands : categories).map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
    [mode, brands, categories],
  );

  function onPick(files: FileList | null) {
    if (!files || files.length === 0) { setPicked([]); setResults([]); return; }
    const arr = Array.from(files).slice(0, 50);  // hard cap per batch
    setPicked(arr);
    const matches = matchFilenamesToCandidates(arr.map((f) => f.name), candidates);
    setResults(matches.map((m) => ({ match: m, state: 'pending' })));
  }

  async function runUploads() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    const kind = KIND_FOR_MODE[mode];
    const next: FileResult[] = [];
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i]!;
      const fr   = results[i]!;
      next.push({ ...fr, state: 'uploading' });
      setResults([...next]);
      try {
        // api() JSON-stringifies the body; multipart uploads must bypass.
        // Same pattern as <ImageUploadInput>.
        if (!readCookie('sc_csrf')) {
          await fetch('/api/auth/csrf', { credentials: 'same-origin' });
        }
        const csrf = readCookie('sc_csrf') ?? '';
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/admin/uploads?kind=${kind}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'x-csrf-token': csrf },
          body: form,
        });
        const json = await res.json().catch(() => ({})) as { ok?: boolean; data?: { url: string }; error?: string };
        if (res.ok && json.ok && json.data) next[i] = { ...fr, state: 'done', url: json.data.url };
        else                                next[i] = { ...fr, state: 'error', err: json.error ?? `Upload failed (HTTP ${res.status}).` };
      } catch (e) {
        next[i] = { ...fr, state: 'error', err: (e as Error).message };
      }
      setResults([...next]);
    }
    setBusy(false);
    onUploaded();
    const okCount = next.filter((x) => x.state === 'done').length;
    await dialog.alert({
      title:   'Bulk upload complete',
      message: `${okCount} of ${picked.length} file(s) uploaded.\n\nThe URLs are listed below — copy them onto each ${mode} via Edit (or use the per-row uploader on the ${mode} admin page).`,
    });
  }

  function clearAll() {
    setPicked([]); setResults([]);
    if (fileRef.current) fileRef.current.value = '';
  }

  const matchedCount   = results.filter((r) => r.match.matchType !== 'none').length;
  const unmatchedCount = results.length - matchedCount;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Bulk upload</h2>
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-xs">
          {(['brand', 'category'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setPicked([]); setResults([]); }}
              className={`rounded px-3 py-1 font-semibold ${mode === m ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              {m === 'brand' ? 'Brand logos' : 'Category tiles'}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 text-xs text-slate-600">
        Pick multiple images at once. The dashboard matches each filename to a {mode} slug
        (`apple.png` → <code>apple</code>). Unmatched files appear in the list — assign them
        manually via the {mode} admin page after upload.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif,image/heic,image/heif"
        multiple
        onChange={(e) => onPick(e.target.files)}
        disabled={busy}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700"
      />

      {results.length > 0 && (
        <>
          <p className="mt-3 text-xs text-slate-700">
            <strong>{matchedCount}</strong> matched · <strong>{unmatchedCount}</strong> unmatched
          </p>
          <div className="mt-2 max-h-64 overflow-y-auto rounded border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase">
                <tr>
                  <th className="px-2 py-1.5 text-left">File</th>
                  <th className="px-2 py-1.5 text-left">Match</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((r) => (
                  <tr key={r.match.filename}>
                    <td className="px-2 py-1.5 font-mono">{r.match.filename}</td>
                    <td className="px-2 py-1.5">
                      {r.match.matchType === 'exact' && <span className="font-semibold text-emerald-700">{r.match.match!.slug}</span>}
                      {r.match.matchType === 'fuzzy' && <span className="font-semibold text-amber-700">~{r.match.match!.slug}</span>}
                      {r.match.matchType === 'none'  && <span className="italic text-slate-400">unmatched</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.state === 'pending'   && <span className="text-slate-500">pending</span>}
                      {r.state === 'uploading' && <span className="text-blue-700">uploading…</span>}
                      {r.state === 'done'      && <span className="text-emerald-700">done ✓</span>}
                      {r.state === 'error'     && <span className="text-red-700" title={r.err}>error</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.url ? <code className="break-all text-[10px]">{r.url}</code> : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void runUploads()} disabled={busy || picked.length === 0}>
              {busy ? 'Uploading…' : `Upload ${picked.length} file${picked.length === 1 ? '' : 's'}`}
            </Button>
            <Button tone="ghost" onClick={clearAll} disabled={busy}>Clear</Button>
          </div>
        </>
      )}
    </Card>
  );
}
