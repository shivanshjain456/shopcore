'use client';

import { useCart } from './CartProvider';
import { useState } from 'react';

export default function QuantityControl({ itemId, quantity, stock }: { itemId: string; quantity: number; stock: number }) {
  const { update } = useCart();
  const [busy, setBusy] = useState(false);

  async function set(qty: number) {
    if (busy) return;
    setBusy(true);
    await update(itemId, Math.max(0, Math.min(10, qty)));
    setBusy(false);
  }

  return (
    <div className="inline-flex items-center rounded-lg border border-slate-300">
      <button
        type="button" disabled={busy || quantity <= 1}
        onClick={() => set(quantity - 1)}
        className="grid h-8 w-8 place-items-center text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        aria-label="Decrease"
      >−</button>
      <span className="min-w-8 px-2 text-center text-sm font-semibold">{quantity}</span>
      <button
        type="button" disabled={busy || quantity >= Math.min(10, stock)}
        onClick={() => set(quantity + 1)}
        className="grid h-8 w-8 place-items-center text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        aria-label="Increase"
      >+</button>
    </div>
  );
}
