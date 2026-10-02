'use client';
/**
 * ── AppDialog — production-grade replacement for window.{alert,confirm,prompt} ──
 *
 * Built on the native <dialog> element, which gives us for free:
 *   - Real focus trap when opened via `dialog.showModal()`
 *   - Native Escape-to-close
 *   - Native ::backdrop pseudo-element
 *   - Top-layer rendering (always above stacking contexts)
 *   - Proper `role="dialog"` + `aria-modal="true"` semantics
 *
 * Three modes, each a strict superset of the corresponding native primitive:
 *
 *   ┌─────────┬──────────────────────────────┬────────────────────────────┐
 *   │ mode    │ replaces                     │ resolves to                │
 *   ├─────────┼──────────────────────────────┼────────────────────────────┤
 *   │ alert   │ window.alert(msg)            │ void                       │
 *   │ confirm │ window.confirm(msg) → bool   │ true | false               │
 *   │ prompt  │ window.prompt(msg, def)→str  │ string | null              │
 *   └─────────┴──────────────────────────────┴────────────────────────────┘
 *
 * Use via the `useDialog()` hook — see `DialogProvider.tsx`. This file
 * exports the headless component for the rare call site that wants its
 * own dialog instance + the imperative `useDialog()` API for the global one.
 *
 * Accessibility checklist:
 *   - Focus moves to the first focusable element (input on prompt, primary
 *     button on alert/confirm) when opened — handled by useEffect below.
 *   - Escape dismisses (resolves cancel).
 *   - Click outside the dialog content (on the ::backdrop) dismisses.
 *   - Enter in the prompt input submits.
 *   - role="dialog" + aria-modal="true" + aria-labelledby + aria-describedby
 *     all set on the <dialog>.
 *   - aria-invalid + aria-describedby surface validation errors to AT.
 *   - The "destructive" intent renders the primary button in red but does
 *     NOT rely on colour alone — copy + icon convey the action too.
 */
import React, {
  forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, useCallback,
  type FormEvent, type KeyboardEvent, type MouseEvent,
} from 'react';

export type DialogIntent = 'info' | 'success' | 'warning' | 'destructive';
export type DialogMode = 'alert' | 'confirm' | 'prompt';

export interface DialogConfigBase {
  /** Heading shown at the top — required for accessibility (aria-labelledby). */
  title: string;
  /** Body copy. Plain string only — pass elements via `description` slot. */
  message?: string;
  /** Optional ReactNode body shown beneath `message`. */
  description?: React.ReactNode;
  /** Primary button label. Defaults: alert='OK', confirm='Confirm', prompt='Submit'. */
  confirmLabel?: string;
  /** Secondary button label. Defaults: confirm/prompt='Cancel'. Alert has no cancel. */
  cancelLabel?: string;
  /** Visual intent — drives the primary button colour + icon. */
  intent?: DialogIntent;
}

export interface PromptConfig extends DialogConfigBase {
  /** Initial value pre-filled into the input. */
  defaultValue?: string;
  /** Placeholder. */
  placeholder?: string;
  /** Max input length. */
  maxLength?: number;
  /** Force non-empty on submit. */
  required?: boolean;
  /** input type — text | password | email | tel | url | number. */
  inputType?: 'text' | 'password' | 'email' | 'tel' | 'url' | 'number';
  /** Custom synchronous validator — return null if ok, string error otherwise. */
  validate?: (value: string) => string | null;
  /** Multiline → renders <textarea>. */
  multiline?: boolean;
}

export type DialogConfig =
  | ({ mode: 'alert'   } & DialogConfigBase)
  | ({ mode: 'confirm' } & DialogConfigBase)
  | ({ mode: 'prompt'  } & PromptConfig);

/**
 * Per-mode resolution contract:
 *   alert   → undefined when closed (any path)
 *   confirm → true on OK, false on Cancel/Escape/backdrop
 *   prompt  → typed string on OK, null on Cancel/Escape/backdrop
 *
 * The provider casts at the boundary; this loose handle keeps the headless
 * component reusable.
 */
export interface AppDialogHandle {
  open: (cfg: DialogConfig) => Promise<unknown>;
  close: () => void;
}

/**
 * Headless, fully-controlled dialog. Most code should use the global
 * `useDialog()` hook (DialogProvider) instead of mounting this directly.
 */
const AppDialog = forwardRef<AppDialogHandle, { 'data-testid'?: string }>(function AppDialog(
  { 'data-testid': testId = 'app-dialog' },
  ref,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef  = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Single open-call state. Only one dialog is shown at a time per instance.
  const [cfg, setCfg] = useState<DialogConfig | null>(null);
  const [inputValue, setInputValue] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const descId  = useId();
  const errorId = useId();

  // Resolver — set by `open()`, called by close paths.
  const resolverRef = useRef<((v: unknown) => void) | null>(null);
  // Marks "closing" so the CSS exit animation can play before .close() fires.
  const [closing, setClosing] = useState(false);
  // Guards against double-resolve during the closing animation window.
  const closingRef = useRef(false);

  const resolve = useCallback((value: unknown) => {
    if (closingRef.current) return;
    closingRef.current = true;
    const r = resolverRef.current;
    resolverRef.current = null;
    const d = dialogRef.current;

    // Resolve the awaited promise immediately so callers can navigate /
    // mutate state in parallel with the visual exit animation. The DOM
    // tear-down completes asynchronously after the CSS animation finishes.
    if (r) r(value);

    const finish = () => {
      try { if (d?.open) d.close(); } catch { /* */ }
      setClosing(false);
      closingRef.current = false;
      setCfg(null);
      setError(null);
      setInputValue('');
    };

    if (!d || !d.open) { finish(); return; }
    // Reduced-motion / no-animation paths still get a clean close.
    setClosing(true);
    const onEnd = () => { d.removeEventListener('animationend', onEnd); finish(); };
    d.addEventListener('animationend', onEnd);
    // Safety net: if animationend never fires (e.g. jsdom, or CSS strip-out),
    // fall back to a 180ms timeout (matches CSS duration + 40ms slack).
    setTimeout(() => {
      if (closingRef.current) { d.removeEventListener('animationend', onEnd); finish(); }
    }, 180);
  }, []);

  // Imperative API
  useImperativeHandle(ref, () => ({
    open(c: DialogConfig) {
      // Cancel any in-progress close animation cleanly. The previous open's
      // promise was already resolved by `resolve()`; we just need to reset
      // the "closing" guards so this new open isn't immediately torn down.
      closingRef.current = false;
      setClosing(false);
      setCfg(c);
      setInputValue(c.mode === 'prompt' ? ((c as PromptConfig).defaultValue ?? '') : '');
      setError(null);
      // Show on next paint so the <dialog> is in the DOM.
      return new Promise<unknown>((res) => {
        resolverRef.current = res;
        // Defer showModal until after React commits the new DOM.
        queueMicrotask(() => {
          const d = dialogRef.current;
          if (d && !d.open) {
            try { d.showModal(); } catch { /* jsdom may lack showModal in some versions */ }
          }
        });
      });
    },
    close() { resolve(cfg?.mode === 'confirm' ? false : cfg?.mode === 'prompt' ? null : undefined); },
  }), [cfg, resolve]);

  // Auto-focus on open
  useEffect(() => {
    if (!cfg) return;
    queueMicrotask(() => {
      if (cfg.mode === 'prompt') inputRef.current?.focus();
      else primaryRef.current?.focus();
    });
  }, [cfg]);

  if (!cfg) return null;

  const intent: DialogIntent = cfg.intent ?? (cfg.mode === 'alert' ? 'info' : 'warning');
  const confirmLabel = cfg.confirmLabel
    ?? (cfg.mode === 'alert' ? 'OK' : cfg.mode === 'prompt' ? 'Submit' : 'Confirm');
  const cancelLabel = cfg.cancelLabel ?? 'Cancel';

  function onCancel() {
    if (!cfg) return;
    resolve(cfg.mode === 'confirm' ? false : cfg.mode === 'prompt' ? null : undefined);
  }

  function onSubmit(e?: FormEvent) {
    if (e) e.preventDefault();
    if (!cfg) return;
    if (cfg.mode === 'prompt') {
      const v = inputValue;
      if (cfg.required && v.trim().length === 0) {
        setError('This field is required.');
        return;
      }
      const validator = (cfg as PromptConfig).validate;
      if (validator) {
        const msg = validator(v);
        if (msg) { setError(msg); return; }
      }
      resolve(v);
    } else if (cfg.mode === 'confirm') {
      resolve(true);
    } else {
      resolve(undefined);
    }
  }

  // The native <dialog> emits 'cancel' on Escape — wire to our resolver.
  function onNativeCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onCancel();
  }

  // Backdrop click — the <dialog> itself receives clicks both inside and on
  // the backdrop. We treat clicks on the <dialog> element itself (not its
  // children) as backdrop clicks.
  function onDialogClick(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onCancel();
  }

  // Trap Enter on prompt input (single-line) → submit, except in textarea
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (cfg?.mode === 'prompt' && e.key === 'Enter' && !(cfg as PromptConfig).multiline) {
      onSubmit();
    }
  }

  const intentClass: Record<DialogIntent, string> = {
    info:        'bg-brand-600 hover:bg-brand-700 focus:ring-brand-400',
    success:     'bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-400',
    warning:     'bg-amber-600 hover:bg-amber-700 focus:ring-amber-400',
    destructive: 'bg-red-600 hover:bg-red-700 focus:ring-red-400',
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={cfg.message ? descId : undefined}
      data-testid={testId}
      data-mode={cfg.mode}
      data-intent={intent}
      data-closing={closing ? 'true' : undefined}
      onCancel={onNativeCancel}
      onClick={onDialogClick}
      // IMPORTANT: every visual property of the dialog (background, border,
      // size, shadow, radius) is owned by `dialog.app-dialog` in
      // `app/globals.css`. We deliberately AVOID Tailwind utilities like
      // `bg-white` / `rounded-2xl` here — the CSS-rule specificity used to
      // include `background: transparent`, which beat `.bg-white` and let
      // the ::backdrop tint bleed THROUGH the dialog, muddying its content
      // and breaking WCAG-AA contrast. Keeping styling in ONE place removes
      // that whole class of bug.
      className="app-dialog"
    >
      <form method="dialog" onSubmit={onSubmit} className="flex max-h-[inherit] min-h-0 flex-col" onKeyDown={onKeyDown}>
        <header className="border-b border-slate-100 px-4 py-3 sm:px-6 sm:py-4">
          <h2 id={titleId} data-testid="app-dialog-title" className="text-base font-semibold text-slate-900">
            {cfg.title}
          </h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6 sm:py-4 space-y-3">
          {cfg.message && (
            <p id={descId} data-testid="app-dialog-message" className="text-sm text-slate-700 whitespace-pre-line">
              {cfg.message}
            </p>
          )}
          {cfg.description && (
            <div className="text-sm text-slate-700">{cfg.description}</div>
          )}

          {cfg.mode === 'prompt' && (
            <div className="flex flex-col gap-1">
              {(cfg as PromptConfig).multiline ? (
                <textarea
                  ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                  data-testid="app-dialog-input"
                  value={inputValue}
                  onChange={(e) => { setInputValue(e.target.value); if (error) setError(null); }}
                  placeholder={(cfg as PromptConfig).placeholder}
                  maxLength={(cfg as PromptConfig).maxLength}
                  rows={4}
                  aria-invalid={!!error}
                  aria-required={(cfg as PromptConfig).required ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  // NB: deliberately NOT using HTML `required` — we run the
                  // check in onSubmit() so the validation error renders via
                  // our own UI (consistent with custom validators below).
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              ) : (
                <input
                  ref={inputRef as React.RefObject<HTMLInputElement>}
                  data-testid="app-dialog-input"
                  type={(cfg as PromptConfig).inputType ?? 'text'}
                  value={inputValue}
                  onChange={(e) => { setInputValue(e.target.value); if (error) setError(null); }}
                  placeholder={(cfg as PromptConfig).placeholder}
                  maxLength={(cfg as PromptConfig).maxLength}
                  aria-invalid={!!error}
                  aria-required={(cfg as PromptConfig).required ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  // see note above; we own the required check in onSubmit().
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              )}
              {error && (
                <p id={errorId} role="alert" data-testid="app-dialog-error" className="text-xs text-red-600">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer — on phones the buttons stack full-width (primary first
            for thumb-reach), on ≥sm we keep the classic horizontal pair
            with the primary action on the right. */}
        <footer className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3 sm:flex-row-reverse sm:px-6">
          <button
            ref={primaryRef}
            type="submit"
            data-testid="app-dialog-confirm"
            className={`tap-target inline-flex items-center justify-center rounded-md px-4 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-offset-1 ${intentClass[intent]}`}
          >
            {confirmLabel}
          </button>
          {cfg.mode !== 'alert' && (
            <button
              type="button"
              data-testid="app-dialog-cancel"
              onClick={onCancel}
              className="tap-target inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              {cancelLabel}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
});

export default AppDialog;
