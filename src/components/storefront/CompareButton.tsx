'use client';
/**
 * <CompareButton> — Item 14.
 *
 * Toggles a product into / out of the shared compare list. Reads state
 * from the `CompareProvider` so the UI stays in sync across PDP /
 * product cards / tray.
 *
 * Visual states:
 *   - Default       — outline button "Add to compare"
 *   - In compare    — filled button "✓ In compare" (clicking removes)
 *   - List full     — disabled button "Compare full (N/N)" + tooltip
 *   - Loading       — disabled with subtle pulse
 *
 * Failure handling uses the AppDialog, not `window.alert` — every
 * error path surfaces a real, accessible modal.
 */
import { useState } from 'react';
import { useCompare } from './CompareProvider';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Props {
  productId: string;
  /** Visual size — defaults to `md` for PDP usage. */
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLS: Record<NonNullable<Props['size']>, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

export default function CompareButton({ productId, size = 'md', className }: Props) {
  const compare = useCompare();
  const dialog  = useDialog();
  const [busy, setBusy] = useState(false);

  const isIn   = compare.has(productId);
  const isFull = !isIn && compare.items.length >= compare.maxItems;

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      if (isIn) {
        await compare.remove(productId);
        return;
      }
      if (isFull) {
        await dialog.alert({
          title:   'Compare list full',
          message: `You can compare up to ${compare.maxItems} products at a time. Remove one to add another.`,
        });
        return;
      }
      const r = await compare.add(productId);
      if (!r.ok) {
        await dialog.alert({
          title:   'Could not add to compare',
          message: r.message,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const label = isIn   ? '✓ In compare'
              : isFull ? `Compare full (${compare.items.length}/${compare.maxItems})`
              :          'Add to compare';

  const baseCls = isIn
    ? 'border-brand-600 bg-brand-50 text-brand-800 hover:bg-brand-100'
    : isFull
      ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || (isFull && !isIn)}
      aria-pressed={isIn}
      aria-label={isIn ? 'Remove from compare' : 'Add to compare'}
      title={isFull && !isIn ? `Max ${compare.maxItems} products. Remove one to add another.` : undefined}
      className={`inline-flex items-center rounded-md border font-semibold transition ${SIZE_CLS[size]} ${baseCls} ${busy ? 'opacity-60' : ''} ${className ?? ''}`}
    >
      {label}
    </button>
  );
}
