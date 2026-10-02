'use client';
/**
 * Global dialog provider — mount ONCE at the app root.
 *
 * Exposes `useDialog()` which returns three promise-returning helpers that
 * directly mirror the native primitives they replace:
 *
 *     const { confirm, alert, promptUser } = useDialog();
 *     const ok    = await confirm({ title: 'Delete?', message: '...', intent: 'destructive' });
 *     await       alert  ({ title: 'Done', message: 'Saved.' });
 *     const note  = await promptUser({ title: 'Reason', required: true });
 *
 * The promise resolution rules match window.* exactly:
 *   - confirm → true | false
 *   - alert   → void
 *   - prompt  → string | null
 *
 * Provider behaviour:
 *   - Singleton — only ONE dialog open at a time. A second open() while the
 *     first is unresolved is rejected with `Error('dialog_busy')`. This is
 *     intentional: stacking modals is an anti-pattern.
 *   - SSR-safe — renders nothing on the server.
 */
import React, { createContext, useContext, useMemo, useRef } from 'react';
import AppDialog, { type AppDialogHandle, type DialogConfigBase, type PromptConfig } from './AppDialog';

type ConfirmConfig = DialogConfigBase;
type AlertConfig   = DialogConfigBase;

interface DialogApi {
  /** Replaces window.confirm(). */
  confirm:     (cfg: ConfirmConfig) => Promise<boolean>;
  /** Replaces window.alert(). */
  alert:       (cfg: AlertConfig)   => Promise<void>;
  /** Replaces window.prompt(). Renamed to avoid shadowing `prompt` keyword in linters. */
  promptUser:  (cfg: PromptConfig)  => Promise<string | null>;
}

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const v = useContext(Ctx);
  if (!v) {
    // Fail loudly — using the hook outside the provider is a programming error.
    throw new Error('useDialog() must be used inside <DialogProvider>.');
  }
  return v;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const handleRef = useRef<AppDialogHandle | null>(null);
  const busyRef   = useRef<boolean>(false);

  const api: DialogApi = useMemo(() => {
    function guard<T>(fn: () => Promise<T>): Promise<T> {
      if (busyRef.current) {
        // Stacked-open: reject so the caller doesn't silently hang. Pages
        // should never open a dialog from inside a dialog handler — they
        // should close the first one first.
        return Promise.reject(new Error('dialog_busy'));
      }
      busyRef.current = true;
      return fn().finally(() => { busyRef.current = false; });
    }
    return {
      confirm: (cfg) => guard(async () => {
        const v = await handleRef.current!.open({ mode: 'confirm', ...cfg });
        return Boolean(v);
      }),
      alert: (cfg) => guard(async () => {
        await handleRef.current!.open({ mode: 'alert', ...cfg });
      }),
      promptUser: (cfg) => guard(async () => {
        const v = await handleRef.current!.open({ mode: 'prompt', ...cfg });
        return v === null || v === undefined ? null : String(v);
      }),
    };
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <AppDialog ref={handleRef} />
    </Ctx.Provider>
  );
}
