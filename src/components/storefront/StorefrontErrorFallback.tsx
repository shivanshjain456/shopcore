'use client';
/**
 * Storefront-styled error fallback. Rendered when an <ErrorBoundary>
 * inside `(storefront)/layout.tsx` catches a render error. The header
 * + footer continue rendering — only the page-body slot is replaced.
 *
 * NEVER show the raw error / stack to end users — only a friendly
 * message + recovery actions. The actual error is logged server-side
 * via the ErrorBoundary's beacon POST + the client console.
 */
import Link from 'next/link';

export default function StorefrontErrorFallback({ reset }: { reset?: () => void }) {
  return (
    <div className="mx-auto my-16 max-w-xl px-4 text-center">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600" aria-hidden="true">
          ⚠
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Oops, something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">
          We hit an unexpected issue while loading this page. Please try again, or return to the homepage.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => reset?.()}
            className="tap-target inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Try again
          </button>
          <Link
            href="/"
            className="tap-target inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Return to homepage
          </Link>
        </div>
      </div>
    </div>
  );
}
