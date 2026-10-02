'use client';
/**
 * <ErrorBoundary> — React class-based error boundary.
 *
 * Catches RENDER-time errors in client components below it. Does NOT
 * catch:
 *   - Server component errors (those bubble to `error.tsx`)
 *   - Errors thrown in async event handlers (those need their own
 *     try/catch inside the handler)
 *   - Errors thrown by the boundary itself
 *   - Errors thrown during the initial render of the boundary's own
 *     `fallback` prop (don't put complex logic in the fallback)
 *
 * The boundary is INTENTIONALLY scoped:
 *
 *   - Storefront layout wraps `{children}` only — header + footer
 *     stay rendered when a page errors, so a user with a broken cart
 *     page can still navigate.
 *   - Admin layout same — sidebar + topbar survive a page crash.
 *   - We do NOT wrap at the root layout — Next.js's `global-error.tsx`
 *     handles that case.
 *
 * Logging: the boundary cannot use the server logger (it runs in the
 * browser). It calls a tiny client reporter that POSTs to the server
 * (best-effort) and falls back to `console.error` if the POST fails.
 * Per the audit allow-list, `console.error` is the one legitimate
 * client-bundle escape hatch — this file is intrinsically client-side.
 */
import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** What to render when the boundary catches an error. If omitted,
   *  a minimal default fallback is rendered. */
  fallback?: ReactNode | ((args: { error: Error; reset: () => void }) => ReactNode);
  /** Optional callback for reporting / analytics. Receives the error
   *  + React's component-tree info. */
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 1. Best-effort client-side reporter. Fires-and-forgets a POST so
    //    server logs capture the client crash. `keepalive: true` lets
    //    the request complete even if the user navigates away.
    try {
      void fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
          path: typeof window !== 'undefined' ? window.location.pathname : '',
        }),
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch { /* network down or beacon refused — fall through */ }

    // 2. DEV-VISIBLE console for the developer hot-loop. In production
    //    this still helps for users who file a bug report with the
    //    devtools open. The audit allowlists this file by virtue of
    //    its `'use client'` pragma (process.stdout doesn't exist).
    //    eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);

    // 3. Caller-supplied reporter.
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fb = this.props.fallback;
    if (typeof fb === 'function') return fb({ error, reset: this.reset });
    if (fb !== undefined) return fb;
    // Minimal default fallback — used when the layout-level fallback
    // isn't provided (rare).
    return (
      <div role="alert" className="mx-auto my-12 max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <h2 className="text-lg font-semibold text-red-800">Something went wrong</h2>
        <p className="mt-2 text-sm text-red-700">An unexpected error occurred on this page.</p>
        <button
          type="button"
          onClick={this.reset}
          className="tap-target mt-4 inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          Try again
        </button>
      </div>
    );
  }
}

/** HOC wrapper — `withErrorBoundary(Component, fallback)`. Convenient
 *  for one-off component wrapping outside a layout. */
export function withErrorBoundary<P extends object>(
  Wrapped: React.ComponentType<P>,
  fallback?: Props['fallback'],
): React.ComponentType<P> {
  function WithBoundary(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <Wrapped {...props} />
      </ErrorBoundary>
    );
  }
  WithBoundary.displayName = `WithErrorBoundary(${Wrapped.displayName ?? Wrapped.name ?? 'Component'})`;
  return WithBoundary;
}
