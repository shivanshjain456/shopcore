'use client';
/**
 * Root-segment error boundary (Next.js convention).
 *
 * Triggered when a SERVER component in any non-layout segment throws
 * during render. Renders INSIDE the root layout (so `<html>`/`<body>`
 * are already present). Receives `{ error, reset }` from Next.js.
 *
 * `error.digest` is Next.js's production error fingerprint — the same
 * string is emitted in server logs (`log.error('api.unhandled', { ... })`
 * via the request that crashed). We display it to the user so a
 * support ticket can include it for fast triage.
 *
 * Per the project security policy, we NEVER render `error.message`
 * to users — production messages may carry internal detail. The
 * digest is opaque and safe.
 */
import { useEffect } from 'react';
import Link from 'next/link';

export default function RootSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Best-effort client beacon — same shape as <ErrorBoundary>.
    try {
      void fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
          digest: error.digest,
          path: typeof window !== 'undefined' ? window.location.pathname : '',
          source: 'root-segment-error',
        }),
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch { /* offline / blocked — silent */ }
  }, [error]);

  return (
    <main className="min-h-[60vh] bg-slate-50 px-4 py-16">
      <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600" aria-hidden="true">
          ⚠
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">
          We hit an unexpected issue. Please try again, or return to the homepage.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-slate-500">
            Reference: <span className="font-semibold">{error.digest}</span>
          </p>
        )}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => reset()}
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
    </main>
  );
}
