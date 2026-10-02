'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

export default function ReorderButton({ orderId, size = 'sm' }: { orderId: string; size?: 'sm' | 'md' }) {
  const router = useRouter();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const cls = size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';

  async function onClick(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setBusy(true);
    const r = await api<{ added: unknown[]; skipped: { name: string; reason: string }[] }>('/api/account/reorder', { method: 'POST', body: { orderId } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Could not reorder', message: r.error ?? 'Please try again.' }); return; }
    const skipped = r.data?.skipped ?? [];
    if (skipped.length > 0) {
      await dialog.alert({
        title: 'Some items could not be re-added',
        message: `${skipped.map((s) => `• ${s.name} — ${s.reason}`).join('\n')}\n\nYour cart has the rest.`,
        intent: 'warning',
      });
    }
    router.push('/cart');
  }

  return (
    <button type="button" onClick={onClick} disabled={busy}
            className={`inline-flex items-center rounded-md border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 ${cls}`}>
      {busy ? 'Re-adding…' : 'Reorder'}
    </button>
  );
}
