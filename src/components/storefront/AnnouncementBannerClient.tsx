'use client';
/**
 * Client half of the announcement banner — owns the dismiss button
 * and the `localStorage` flag.
 */
import { useEffect, useState } from 'react';

type BannerType = 'info' | 'warning' | 'error' | 'success';

const PALETTE: Record<BannerType, { bar: string; text: string; btn: string }> = {
  info:    { bar: 'bg-sky-50 border-sky-200',          text: 'text-sky-900',     btn: 'text-sky-700 hover:bg-sky-100' },
  warning: { bar: 'bg-amber-50 border-amber-200',      text: 'text-amber-900',   btn: 'text-amber-700 hover:bg-amber-100' },
  error:   { bar: 'bg-red-50 border-red-200',          text: 'text-red-900',     btn: 'text-red-700 hover:bg-red-100' },
  success: { bar: 'bg-emerald-50 border-emerald-200',  text: 'text-emerald-900', btn: 'text-emerald-700 hover:bg-emerald-100' },
};

const LS_KEY_PREFIX = 'shopcore.banner.dismissed.';

export function AnnouncementBannerClient({
  message,
  type,
  dismissKey,
}: {
  message:    string;
  type:       BannerType;
  dismissKey: string;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated]   = useState(false);

  useEffect(() => {
    setHydrated(true);
    try {
      const v = window.localStorage.getItem(LS_KEY_PREFIX + dismissKey);
      if (v === '1') setDismissed(true);
    } catch { /* localStorage blocked; render banner */ }
  }, [dismissKey]);

  if (dismissed) return null;
  // SSR + first paint render the banner; client hydration may immediately
  // remove it if the viewer previously dismissed this message — fine.

  const p = PALETTE[type] ?? PALETTE.info;

  return (
    <div
      className={`border-b ${p.bar} ${p.text}`}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
    >
      <div className="mx-auto flex max-w-screen-xl items-center gap-3 px-4 py-2 text-sm">
        <p className="flex-1">{message}</p>
        {hydrated && (
          <button
            type="button"
            className={`tap-target rounded-md px-2 py-1 text-xs font-semibold ${p.btn}`}
            onClick={() => {
              try { window.localStorage.setItem(LS_KEY_PREFIX + dismissKey, '1'); } catch { /* */ }
              setDismissed(true);
            }}
            aria-label="Dismiss announcement"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
