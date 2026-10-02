'use client';
/**
 * <CompareTray> — Item 14.
 *
 * Floating, full-width-on-mobile / centred-on-desktop tray that follows
 * the user across pages. Shows compare list thumbnails + a "Compare
 * now" CTA + "Clear all" action.
 *
 * Hidden when:
 *   - The feature flag `features.compareEnabled` is off (the provider
 *     never receives items in that case → length 0).
 *   - The compare list is empty.
 *   - The user is on the /compare page itself (redundant — useDialog
 *     and the table provide the same actions).
 *   - The provider is still loading on first render (avoids flash).
 *
 * a11y: rendered inside a `<section role="region" aria-label="…">`
 * so screen-reader users can navigate to it. The "Clear all" action
 * confirms via `useDialog()` — never `window.confirm`.
 *
 * Entrance: slide-up via CSS transition, suppressed under
 * `prefers-reduced-motion: reduce`.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCompare } from './CompareProvider';
import { useDialog } from '@/components/dialog/DialogProvider';
import { api } from '@/lib/client/api';

interface ThumbProduct {
  id:       string;
  slug:     string;
  name:     string;
  imageUrl: string | null;
}

/** Fetch lightweight metadata for the tray thumbnails. The provider
 *  only holds IDs; the tray queries /api/compare for the full shape
 *  but extracts just image/slug/name. */
async function loadThumbs(): Promise<ThumbProduct[]> {
  const r = await api<{
    items: Array<{ product: { id: string; slug: string; name: string; imageUrl: string | null } }>;
  }>('/api/compare');
  if (!r.ok || !r.data) return [];
  return r.data.items.map((it) => ({
    id:       it.product.id,
    slug:     it.product.slug,
    name:     it.product.name,
    imageUrl: it.product.imageUrl,
  }));
}

export default function CompareTray() {
  const pathname = usePathname();
  const compare  = useCompare();
  const dialog   = useDialog();
  const [thumbs, setThumbs] = useState<ThumbProduct[]>([]);

  // Re-fetch thumbs whenever the IDs change. We tag the dependency on
  // a joined-string of IDs so deep equality fires only on actual list
  // change (length or content).
  const idsKey = compare.items.map((e) => e.productId).join(',');
  useEffect(() => {
    if (compare.items.length === 0) { setThumbs([]); return; }
    let cancelled = false;
    void (async () => {
      const list = await loadThumbs();
      if (!cancelled) setThumbs(list);
    })();
    return () => { cancelled = true; };
  }, [idsKey, compare.items.length]);

  // Visibility rules.
  if (compare.loading)               return null;
  if (compare.items.length === 0)    return null;
  if (pathname === '/compare')       return null;

  async function onClear() {
    const ok = await dialog.confirm({
      title:        'Clear comparison?',
      message:      'All products will be removed from your compare list.',
      confirmLabel: 'Clear all',
      intent:       'destructive',
    });
    if (!ok) return;
    await compare.clear();
  }

  async function onRemove(productId: string) {
    await compare.remove(productId);
  }

  const count = compare.items.length;
  const max   = compare.maxItems;

  return (
    <section
      role="region"
      aria-label="Compare tray"
      className="fixed inset-x-0 bottom-0 z-40 print:hidden sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:-translate-x-1/2 sm:max-w-2xl"
    >
      <div className="motion-safe:animate-[slide-up_180ms_ease-out] border-t border-slate-200 bg-white shadow-lg sm:rounded-xl sm:border">
        <div className="flex items-center gap-3 px-3 py-2 sm:px-4 sm:py-3">
          {/* Thumbnails */}
          <ul className="flex flex-1 items-center gap-2 overflow-x-auto" aria-label="Selected products">
            {thumbs.map((p) => (
              <li key={p.id} className="relative shrink-0">
                <Link
                  href={`/p/${p.slug}`}
                  className="block h-12 w-12 overflow-hidden rounded-md border border-slate-200 bg-slate-50 sm:h-14 sm:w-14"
                  title={p.name}
                  aria-label={`${p.name} (in compare)`}
                >
                  {p.imageUrl
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover" />
                    : <span className="grid h-full w-full place-items-center text-[10px] text-slate-400">no img</span>}
                </Link>
                <button
                  type="button"
                  onClick={() => void onRemove(p.id)}
                  aria-label={`Remove ${p.name} from compare`}
                  className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-600 shadow hover:bg-slate-100"
                >
                  ×
                </button>
              </li>
            ))}
            {/* Empty slot placeholders so the user sees "of N". */}
            {Array.from({ length: Math.max(0, max - count) }).map((_, i) => (
              <li
                key={`empty-${i}`}
                aria-hidden="true"
                className="h-12 w-12 shrink-0 rounded-md border border-dashed border-slate-200 sm:h-14 sm:w-14"
              />
            ))}
          </ul>

          {/* Count + actions */}
          <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
            <p className="text-xs font-semibold text-slate-700">
              <span className="tabular-nums">{count}</span> of {max}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void onClear()}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear
              </button>
              <Link
                href="/compare"
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
              >
                Compare now
              </Link>
            </div>
          </div>
        </div>
      </div>
      <style jsx global>{`
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .motion-safe\\:animate-\\[slide-up_180ms_ease-out\\] { animation: none !important; }
        }
      `}</style>
    </section>
  );
}
