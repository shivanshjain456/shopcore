/**
 * Storefront-segment 404. Inherits the `(storefront)/layout.tsx` chrome
 * (header + footer) so users get the full navigation surface when they
 * land on an unknown storefront URL.
 */
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function StorefrontNotFound() {
  return (
    <div className="mx-auto my-16 max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <p className="text-6xl font-bold tracking-tight text-slate-300">404</p>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">We couldn&rsquo;t find that page</h1>
      <p className="mt-2 text-sm text-slate-600">
        The page may have been moved, renamed, or deleted. Try one of the links below.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <Link
          href="/"
          className="tap-target inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Homepage
        </Link>
        <Link
          href="/search"
          className="tap-target inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Browse products
        </Link>
      </div>
    </div>
  );
}
