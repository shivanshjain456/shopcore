'use client';
/**
 * BuyNowButton — Direct-to-checkout flow.
 *
 * Click flow:
 *   1. POST /api/checkout/express { productId, variantId?, quantity }
 *   2. Server validates (same Bug #5 stock rules) and upserts the user's
 *      ExpressCheckout row, sets sc_express cookie.
 *   3. We `router.push('/checkout?express=1')` — the checkout page reads
 *      the express row instead of the cart.
 *
 * Edge cases:
 *   - Not signed in (401) → redirect to /login?next=/checkout?express=1.
 *     We DON'T pre-populate anything; user signs in then clicks Buy Now
 *     again on the PDP. Keeps the implementation simple + secure.
 *   - OOS / variant gone / product inactive → dialog.alert with the
 *     server's specific error.
 *   - Rapid clicks → server upserts the same row → no duplicate sessions.
 *
 * Important: this button NEVER touches the user's cart. The express path
 * is fully isolated end-to-end.
 */
import React from 'react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Props {
  productId: string;
  variantId?: string | null;
  quantity?: number;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  'data-testid'?: string;
}

const SIZE: Record<NonNullable<Props['size']>, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export default function BuyNowButton({
  productId, variantId, quantity = 1,
  disabled, size = 'lg',
  label,
  'data-testid': testId = 'buy-now',
}: Props) {
  const router = useRouter();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const r = await api<{ id: string; expiresAt: string; redirect: string }>(
        '/api/checkout/express',
        { method: 'POST', body: { productId, variantId: variantId ?? null, quantity } },
      );
      if (r.status === 401) {
        // Not signed in — bounce through login then back to PDP. The
        // express session itself is created AFTER auth so there's no
        // half-state to clean up.
        router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (!r.ok) {
        await dialog.alert({
          title: 'Cannot buy now',
          message: r.error ?? 'Please try again.',
          intent: 'warning',
        });
        return;
      }
      // We use router.push (not replace) so the browser back button takes
      // the user BACK to the PDP — which leaves the express row sitting
      // server-side until expiry or the user starts a fresh Buy Now. The
      // user's real cart is untouched regardless.
      router.push(r.data?.redirect ?? '/checkout?express=1');
    } finally {
      // Leave `busy` true through navigation; the component unmounts on
      // the next route. If the navigation fails for some reason, busy
      // resets on the next interaction.
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      data-testid={testId}
      aria-label={label ?? 'Buy now'}
      className={`inline-flex items-center justify-center rounded-lg border border-amber-500 bg-amber-500 font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60 ${SIZE[size]}`}
    >
      {busy ? 'Loading checkout…' : (label ?? 'Buy now')}
    </button>
  );
}
