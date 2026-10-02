'use client';
/**
 * <CompareClient> — Item 14.
 *
 * Client wrapper around <CompareTable>. Responsibilities:
 *   - Holds the local mutable copy of the product list (for instant
 *     removal feedback before the next server refresh).
 *   - Dispatches removal into the CompareProvider so the tray + buttons
 *     elsewhere stay in sync.
 *   - When viewing a SHARED url (`?products=…`), removal mutates only
 *     the local view; the user's actual list isn't touched.
 *   - Surfaces a "Save to my compare" CTA on shared-view mode.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useDialog } from '@/components/dialog/DialogProvider';
import { useCompare } from '@/components/storefront/CompareProvider';
import CompareTable from '@/components/storefront/CompareTable';
import type { CompareProduct } from '@/lib/compare/compareData';

interface Props {
  initialProducts: CompareProduct[];
  initialDiff:     boolean;
  /** True when the page loaded via `?products=…` (share-URL view). */
  sharedView:      boolean;
}

export default function CompareClient({ initialProducts, initialDiff, sharedView }: Props) {
  const router  = useRouter();
  const compare = useCompare();
  const dialog  = useDialog();
  const [products, setProducts] = useState<CompareProduct[]>(initialProducts);
  const [pending, startTransition] = useTransition();

  async function onRemove(productId: string): Promise<void> {
    setProducts((cur) => cur.filter((p) => p.id !== productId));
    if (!sharedView) {
      await compare.remove(productId);
      startTransition(() => router.refresh());
    }
  }

  async function onSaveSharedList(): Promise<void> {
    const ok = await dialog.confirm({
      title:        'Save these products?',
      message:      `Add all ${products.length} products to your compare list?`,
      confirmLabel: 'Save',
    });
    if (!ok) return;
    let added = 0;
    let blocked = false;
    for (const p of products) {
      const r = await compare.add(p.id);
      if (r.ok) added++;
      else if (r.code === 'COMPARE_FULL') { blocked = true; break; }
    }
    await dialog.alert({
      title:   blocked ? 'Compare list full' : 'Saved',
      message: blocked
        ? `Added ${added} product${added === 1 ? '' : 's'}. Your list is now full.`
        : `Added ${added} product${added === 1 ? '' : 's'} to your compare list.`,
    });
  }

  return (
    <>
      {sharedView && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">
            Viewing a shared comparison. Removing a product here doesn&apos;t change your own compare list.
          </p>
          <button
            type="button"
            onClick={() => void onSaveSharedList()}
            disabled={pending}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Save to my compare
          </button>
        </div>
      )}

      <CompareTable
        products={products}
        initialDiff={initialDiff}
        onRemove={onRemove}
      />
    </>
  );
}
