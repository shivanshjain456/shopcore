/**
 * /compare — Item 14.
 *
 * Server component. Three load modes:
 *
 *   1. The user's compare list (default).
 *   2. A shared comparison via `?products=slug1,slug2,...` — does NOT
 *      modify the user's actual compare list. Up to 4 slugs accepted,
 *      each must match `[a-z0-9-]+` and be active.
 *   3. The `?diff=1` URL param flips the "Show only differences"
 *      toggle to ON on first paint (the toggle still works client-side
 *      after that).
 *
 * The page is gated by `features.compareEnabled` — when the flag is
 * off the page returns 404 (so the URL itself is invisible — no
 * "Feature unavailable" leak).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { isFeatureOn } from '@/lib/storeConfig/featureGate';
import { listCompare } from '@/lib/account/compare';
import { fetchCompareProducts, resolveSlugsToIds } from '@/lib/compare/compareData';
import { log } from '@/lib/log';
import { headers } from 'next/headers';
import CompareClient from './CompareClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { products?: string; diff?: string };
}

const SLUG_RE = /^[a-z0-9-]+$/;
const SHARE_MAX = 4;

export default async function ComparePage({ searchParams }: PageProps) {
  if (!(await isFeatureOn('features.compareEnabled'))) {
    notFound();
  }

  const sharedSlugs = (searchParams.products ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 64 && SLUG_RE.test(s))
    .slice(0, SHARE_MAX);
  const isSharedView = sharedSlugs.length > 0;

  let productIds: string[] = [];
  if (isSharedView) {
    productIds = await resolveSlugsToIds(sharedSlugs);
    const h = headers();
    const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || null;
    log.info('compare.shared_view', { productIds, ip });
  } else {
    const user    = await getCurrentUser();
    const entries = await listCompare(user?.id ?? null);
    productIds    = entries.map((e) => e.productId);
  }

  const products = await fetchCompareProducts(productIds);
  const initialDiff = searchParams.diff === '1';

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 pb-32">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {isSharedView ? 'Shared comparison' : 'Compare products'}
          </h1>
          <p className="text-sm text-slate-600">
            {isSharedView
              ? 'These products were shared with you. Differences are highlighted.'
              : `Add up to 4 products from any product page using the "Add to compare" button.`}
          </p>
        </div>
      </div>

      {products.length === 0 ? (
        <EmptyState shared={isSharedView} />
      ) : products.length === 1 && !isSharedView ? (
        <OnlyOneState />
      ) : (
        <CompareClient
          initialProducts={products}
          initialDiff={initialDiff}
          sharedView={isSharedView}
        />
      )}
    </main>
  );
}

function EmptyState({ shared }: { shared: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center">
      <p className="text-base font-semibold text-slate-700">
        {shared ? 'No products in this shared link.' : 'No products to compare yet.'}
      </p>
      <p className="mt-2 text-sm text-slate-500">
        Add products by tapping the &quot;Add to compare&quot; button on any product page or product card.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Browse products
      </Link>
    </div>
  );
}

function OnlyOneState() {
  return (
    <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center">
      <p className="text-base font-semibold text-amber-900">Add another product to compare.</p>
      <p className="mt-1 text-sm text-amber-800">
        A comparison needs at least two products to be useful.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Browse more products
      </Link>
    </div>
  );
}
