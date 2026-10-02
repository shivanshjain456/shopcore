'use client';
/**
 * Admin-styled error fallback. Rendered inside the admin shell when
 * a page-level <ErrorBoundary> catches a render error. Admins see
 * slightly more detail than customers (error name + digest if any)
 * to make support easier — but never a raw stack.
 */
import Link from 'next/link';

interface Props {
  error?: { name?: string; message?: string; digest?: string };
  reset?: () => void;
}

export default function AdminErrorFallback({ error, reset }: Props) {
  return (
    <div className="mx-auto my-12 max-w-2xl">
      <div className="rounded-xl border border-red-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-red-100 text-red-600" aria-hidden="true">⚠</span>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-900">An error occurred in this panel</h2>
            <p className="mt-1 text-sm text-slate-600">
              {error?.message ?? 'Something went wrong while rendering this page.'}
            </p>
            {error?.digest && (
              <p className="mt-2 font-mono text-xs text-slate-500">
                Reference: <span className="font-semibold">{error.digest}</span>
                <span className="ml-2 text-slate-400">(share this with support if the issue persists)</span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {reset && (
            <button
              type="button"
              onClick={reset}
              className="tap-target inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Try again
            </button>
          )}
          <Link
            href="/admin"
            className="tap-target inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Return to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
