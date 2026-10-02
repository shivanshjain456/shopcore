'use client';
import React from 'react';
/**
 * LogoutButton — Feature #9.
 *
 * Production-grade sign-out trigger. Use anywhere in an authenticated UI.
 *
 * Behaviour:
 *   - On click, opens an AppDialog confirm (Bug #8 dialog system).
 *   - Optional "Sign out of all devices" mode via the `allDevices` prop.
 *   - Awaits `performLogout()` which:
 *       1. POSTs /api/auth/logout (CSRF-guarded)
 *       2. Treats 401/403 as success (idempotent — Edge: "expired session")
 *       3. Clears client cart/session caches
 *   - Navigates to /login?signed_out=1 via router.replace() so the back
 *     button cannot return to the authenticated page.
 *
 * Variants:
 *   - `variant="ghost"` → minimal text-only link (for menus / sidebars)
 *   - `variant="solid"` → bordered pill button (for headers)
 *   - `variant="danger"`→ destructive-styled (for "sign out of all devices")
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDialog } from '@/components/dialog/DialogProvider';
import { performLogout, type LogoutScope } from '@/lib/client/logout';

type Variant = 'ghost' | 'solid' | 'danger' | 'menu';

interface Props {
  /** Default 'current'; pass 'all' for "sign out of every device". */
  scope?: LogoutScope;
  /** Render style. */
  variant?: Variant;
  /** Override the button label. */
  label?: string;
  /** Where to send the user after sign-out. Defaults to /login?signed_out=1. */
  redirectTo?: string;
  /** Pass `false` to skip the confirmation dialog (e.g. inside the dropdown
   *  where one click already implies intent). Defaults to true. */
  confirm?: boolean;
  /** Optional callback fired BEFORE navigation — for cart provider resets etc. */
  onSignedOut?: () => void | Promise<void>;
  /** ARIA + testing handle. */
  'data-testid'?: string;
  className?: string;
}

/**
 * `tap-target` (Feature #14) is added to every variant so the button meets
 * WCAG-AA 44×44 minimums even when the inner padding alone would not.
 */
const STYLES: Record<Variant, string> = {
  ghost:  'tap-target inline-flex items-center rounded-md px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60',
  solid:  'tap-target inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60',
  danger: 'tap-target inline-flex items-center rounded-md px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60',
  menu:   'tap-target block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60',
};

export default function LogoutButton({
  scope = 'current',
  variant = 'solid',
  label,
  redirectTo = '/login?signed_out=1',
  confirm = true,
  onSignedOut,
  'data-testid': testId = `logout-${scope}`,
  className,
}: Props) {
  const router = useRouter();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);

  const buttonText = label ?? (scope === 'all' ? 'Sign out of all devices' : 'Sign out');

  async function onClick() {
    if (busy) return;
    if (confirm) {
      const ok = await dialog.confirm({
        title: scope === 'all' ? 'Sign out of every device?' : 'Sign out?',
        message: scope === 'all'
          ? 'Every signed-in session for your account will end. You will need to sign in again on each device.'
          : 'You will be signed out of this device. You can sign back in anytime.',
        intent: scope === 'all' ? 'destructive' : 'warning',
        confirmLabel: buttonText,
        cancelLabel: 'Stay signed in',
      });
      if (!ok) return;
    }

    setBusy(true);
    try {
      await performLogout(scope);
      if (onSignedOut) { try { await onSignedOut(); } catch { /* */ } }
      // router.replace + refresh = clean state and the back button cannot
      // return to the now-stale authenticated page. (Combined with the
      // bfcache guard mounted in the layout — see BackButtonGuard.tsx —
      // even a Safari bfcache restore reloads to a public page.)
      router.replace(redirectTo);
      router.refresh();
    } finally {
      // Don't unset busy — the navigation unmounts us. If navigation fails
      // we leave the disabled state on, which is the correct UX (prevents
      // a second click while the user figures out what to do).
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      aria-label={buttonText}
      className={className ?? STYLES[variant]}
    >
      {busy ? 'Signing out…' : buttonText}
    </button>
  );
}
