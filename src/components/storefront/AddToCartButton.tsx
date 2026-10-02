'use client';

import { useState } from 'react';
import { useCart } from './CartProvider';

export default function AddToCartButton({
  productId, variantId, disabled, label = 'Add to cart', size = 'md',
}: {
  productId: string;
  variantId?: string | null;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { add } = useCart();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const cls = size === 'lg' ? 'px-6 py-3 text-base' : size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';

  async function onClick() {
    if (busy || disabled) return;
    setBusy(true); setMsg(null);
    const r = await add({ productId, variantId: variantId ?? null, quantity: 1 });
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: 'ok', text: 'Added to cart ✓' });
      setTimeout(() => setMsg(null), 3000);
    } else {
      // Stock / availability errors deserve more reading time and stay visible
      // until the user takes another action.
      setMsg({ kind: 'err', text: r.error ?? 'Could not add to cart.' });
      setTimeout(() => setMsg(null), 8000);
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className={`inline-flex items-center justify-center rounded-lg bg-brand-600 font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 ${cls}`}
      >
        {busy ? 'Adding…' : label}
      </button>
      {msg && (
        <span
          role={msg.kind === 'err' ? 'alert' : 'status'}
          aria-live={msg.kind === 'err' ? 'assertive' : 'polite'}
          data-testid={`add-to-cart-${msg.kind}`}
          className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
