'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';
import ReorderButton from './ReorderButton';

const CANCELLABLE = new Set(['PENDING_PAYMENT_REVIEW', 'PAYMENT_VERIFIED', 'PROCESSING']);
const RETURNABLE  = new Set(['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']);

export default function OrderActions({ orderId, status }: { orderId: string; status: string; createdAt: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useDialog();
  const canCancel  = CANCELLABLE.has(status);
  const canReturn  = RETURNABLE.has(status);
  const canReorder = status !== 'PENDING_PAYMENT_REVIEW';

  async function cancel() {
    // We collect the reason FIRST (in the same dialog) so the user can
    // commit + explain in a single confirmation step. Cancelling the
    // dialog aborts the whole flow without any API call.
    const reason = await dialog.promptUser({
      title: 'Cancel this order?',
      message: 'Stock will be restored. This cannot be undone. Tell us why (optional):',
      placeholder: 'e.g. Ordered the wrong size',
      multiline: true, maxLength: 500,
      intent: 'destructive', confirmLabel: 'Cancel order', cancelLabel: 'Keep order',
    });
    if (reason === null) return;
    setBusy(true); setErr(null);
    const r = await api(`/api/orders/${orderId}/cancel`, { method: 'POST', body: { reason: reason.trim() || undefined } });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not cancel.'); return; }
    router.refresh();
  }

  if (!canCancel && !canReturn && !canReorder) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Actions</h2>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {canReorder && <ReorderButton orderId={orderId} size="md" />}
        {canReturn && (
          <Link href={`/account/returns/new?orderId=${orderId}`}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Request return / exchange
          </Link>
        )}
        {canCancel && (
          <button
            type="button" onClick={cancel} disabled={busy}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel order'}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Cancellation is allowed before your order ships, within the store&apos;s configured window. Returns/exchanges follow the store&apos;s return policy.
      </p>
    </div>
  );
}
