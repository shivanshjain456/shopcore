'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

export default function WishlistButton({ productId }: { productId: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await api<{ ids: string[] }>('/api/wishlist');
      if (r.ok && r.data) setOn(r.data.ids.includes(productId));
      else setOn(false);
    })();
  }, [productId]);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const r = await api<{ added: boolean }>('/api/wishlist/toggle', { method: 'POST', body: { productId } });
    if (r.ok && r.data) setOn(r.data.added);
    else if (r.status === 401) window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
    setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={on ? 'Remove from wishlist' : 'Add to wishlist'}
      className={`grid h-8 w-8 place-items-center rounded-full border border-slate-200 bg-white/95 shadow-sm transition ${on ? 'text-red-600' : 'text-slate-400 hover:text-red-500'}`}
      title="Wishlist"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );
}
