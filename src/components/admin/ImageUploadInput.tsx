'use client';
/**
 * ImageUploadInput — Feature #16.
 *
 *   A drop-in replacement for "paste an image URL" inputs in the admin UI.
 *   Renders BOTH a URL text input AND a file-picker button (plus drag &
 *   drop). On a successful upload, the returned admin URL is written into
 *   the URL input, so the existing form submission code keeps working
 *   unchanged.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Desktop image *                                            │
 *   │  [thumbnail]  ┌─────────────────────────┐ [📁 Upload] [✕] │
 *   │               │ https://cdn… or /upload/│                  │
 *   │               └─────────────────────────┘                  │
 *   │  Drag & drop an image here, or click "Upload"              │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   Behaviour:
 *     - The URL input is fully editable — admins who already host their
 *       image elsewhere can still paste a URL.
 *     - The "Upload" button opens a native file picker. The selected file
 *       POSTs as multipart/form-data to `/api/admin/uploads?kind=<kind>`
 *       and the returned `data.url` is dropped into the URL input.
 *     - Drag-and-drop onto the component does the same upload.
 *     - Live thumbnail preview whenever the URL is non-empty.
 *     - Inline busy state ("Uploading…"), inline error surface, success
 *       checkmark on completion.
 *     - Fully keyboard-accessible: every control is a real button with a
 *       descriptive aria-label.
 *
 *   Caller contract:
 *     - Controlled: parent owns `value` (the current URL string) and
 *       `onChange(next)`. The component never holds the URL in its own
 *       state — same pattern as <PincodeField> + <PasswordField>.
 *     - The form's `<input name="...">` is RENDERED INSIDE this component
 *       so existing `FormData.get(name)` consumers Just Work.
 */
import React, {
  ChangeEvent, DragEvent, useCallback, useId, useRef, useState,
} from 'react';
import { api } from '@/lib/client/api';

// Item 17 — keep this in sync with src/lib/uploads/imageKinds.ts.
//   We import the type instead of duplicating the union so adding a
//   new kind there propagates here at the type level only (no extra
//   client JS bundled).
import type { AdminImageKind } from '@/lib/uploads/imageKinds';

export interface ImageUploadInputProps {
  /** Current URL value (controlled). */
  value: string;
  /** Parent setter — receives the new URL string. */
  onChange: (next: string) => void;
  /** form-name for the hidden <input> that submits with the form. */
  name: string;
  /** What bucket the file lands in server-side. Affects URL prefix only. */
  kind: AdminImageKind;
  /** Visible label above the field. */
  label?: string;
  /** Visible placeholder for the URL input. */
  placeholder?: string;
  /** Show the "required" asterisk + add `required` to the input. */
  required?: boolean;
  /** Maximum URL length (matches server schema). */
  maxLength?: number;
  /** Compact mode (single-row) for tight forms. Default false. */
  compact?: boolean;
  /** Disable everything. */
  disabled?: boolean;
  /** Test hook. */
  'data-testid'?: string;
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string; pct: number }
  | { kind: 'done'; bytes: number; mime: string }
  | { kind: 'error'; message: string };

export default function ImageUploadInput({
  value, onChange, name, kind,
  label = 'Image URL', placeholder = 'https://cdn... or /uploads/...',
  required = false, maxLength = 2000, compact = false, disabled = false,
  'data-testid': testId = 'image-upload-input',
}: ImageUploadInputProps) {
  const inputId = useId();
  const statusId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [dragOver, setDragOver] = useState(false);

  const doUpload = useCallback(async (file: File) => {
    if (disabled) return;
    if (!file.type.startsWith('image/')) {
      setState({ kind: 'error', message: 'Please choose an image file (JPG / PNG / WEBP).' });
      return;
    }
    setState({ kind: 'uploading', name: file.name, pct: 0 });

    // We use `api()` for the CSRF dance; it auto-attaches the token.
    // The server route runs sharp re-encode then returns the final URL.
    const fd = new FormData();
    fd.append('file', file);

    // We use raw fetch because the project's `api()` helper JSON-stringifies
    // the body; multipart forms need to bypass that. Read CSRF from cookie
    // ourselves to mirror what api() does internally.
    const csrf = readCookie('sc_csrf');
    if (!csrf) {
      // Trigger the existing CSRF-bootstrap endpoint and retry once.
      await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    }
    const csrfTok = readCookie('sc_csrf') ?? '';

    try {
      const res = await fetch(`/api/admin/uploads?kind=${encodeURIComponent(kind)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfTok },
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean; data?: { url: string; mime: string; bytes: number; width: number; height: number };
        error?: string;
      };
      if (!res.ok || !json.ok || !json.data) {
        setState({ kind: 'error', message: json.error ?? `Upload failed (HTTP ${res.status}).` });
        return;
      }
      onChange(json.data.url);
      setState({ kind: 'done', bytes: json.data.bytes, mime: json.data.mime });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message || 'Upload failed.' });
    }
  }, [disabled, kind, onChange]);

  const onPick = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (f) await doUpload(f);
  }, [doUpload]);

  const onDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) await doUpload(f);
  }, [doUpload]);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled) setDragOver(true);
  }, [disabled]);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const clear = useCallback(() => {
    onChange('');
    setState({ kind: 'idle' });
  }, [onChange]);

  const ariaInvalid = state.kind === 'error' ? true : undefined;

  return (
    <div
      data-testid={testId}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        'flex flex-col gap-2 rounded-md border bg-white p-2 transition-colors',
        dragOver
          ? 'border-brand-500 bg-brand-50/40'
          : (state.kind === 'error' ? 'border-red-300' : 'border-slate-200'),
      ].join(' ')}
    >
      <label htmlFor={inputId} className="text-xs font-semibold text-slate-700">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </label>

      <div className={['flex gap-2', compact ? 'items-center' : 'items-start'].join(' ')}>
        {/* Live thumbnail preview — shown only when there's a URL. */}
        {value && (
          <div
            data-testid={`${testId}-thumb`}
            className="relative h-12 w-16 flex-shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={(e) => {
                // Broken URL → hide the image rather than show the broken-image icon.
                (e.currentTarget as HTMLImageElement).style.opacity = '0';
              }}
            />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <input
            id={inputId}
            name={name}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            maxLength={maxLength}
            disabled={disabled}
            aria-describedby={statusId}
            aria-invalid={ariaInvalid}
            data-testid={`${testId}-url`}
            className="block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-mono shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || state.kind === 'uploading'}
            aria-label={state.kind === 'uploading' ? 'Uploading…' : 'Upload image from your computer'}
            data-testid={`${testId}-button`}
            className="tap-target inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M12 4v12m0-12-4 4m4-4 4 4M5 20h14" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="hidden sm:inline">
              {state.kind === 'uploading' ? 'Uploading…' : 'Upload'}
            </span>
          </button>
          {value && (
            <button
              type="button"
              onClick={clear}
              disabled={disabled || state.kind === 'uploading'}
              aria-label="Clear image"
              data-testid={`${testId}-clear`}
              className="tap-target inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              ✕
            </button>
          )}
        </div>

        {/* The actual file input — visually hidden but accessible via the
            Upload button (which calls fileRef.current.click() above). */}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,image/avif"
          onChange={onPick}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          data-testid={`${testId}-file`}
        />
      </div>

      {/* Status line — sticky height so the layout doesn't jump. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        data-testid={`${testId}-status`}
        className={[
          'min-h-[1rem] text-[11px]',
          state.kind === 'error' ? 'text-red-700' : 'text-slate-500',
        ].join(' ')}
      >
        {state.kind === 'idle'      && (dragOver ? 'Drop image to upload…' : 'Paste a URL OR drag & drop an image here, or click Upload.')}
        {state.kind === 'uploading' && `Uploading "${state.name}"…`}
        {state.kind === 'done'      && `✓ Uploaded · ${(state.bytes / 1024).toFixed(0)} KB · ${state.mime.replace('image/', '')}`}
        {state.kind === 'error'     && state.message}
      </p>
    </div>
  );
}

/** Tiny cookie reader — matches the helper inside `lib/client/api.ts`. */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
