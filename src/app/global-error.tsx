'use client';
/**
 * Root-LAYOUT error boundary (Next.js convention).
 *
 * Only triggered when the ROOT layout itself errors during render —
 * a truly unrecoverable state where even `<html>` and `<body>` may
 * not be in place. Must therefore render its own `<html>` + `<body>`
 * shell with ZERO dependencies on the layout tree (no imports of
 * shared providers, no Tailwind reliance on layout-injected variables).
 *
 * Keep this page brutally minimal. Inline styles only — Tailwind
 * classes might not have their CSS loaded.
 */
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      void fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
          digest: error.digest,
          source: 'global-error',
        }),
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch { /* */ }
  }, [error]);

  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#0f172a',
      }}>
        <div style={{
          maxWidth: 480,
          padding: '2rem',
          background: '#ffffff',
          borderRadius: '1rem',
          border: '1px solid #e2e8f0',
          textAlign: 'center',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        }}>
          <div style={{
            width: 56, height: 56, margin: '0 auto 1rem',
            borderRadius: '50%', background: '#fee2e2',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem', color: '#dc2626',
          }} aria-hidden="true">⚠</div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
            ShopCore is temporarily unavailable
          </h1>
          <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#475569' }}>
            We&rsquo;re working to restore service. Please try again shortly.
          </p>
          {error.digest && (
            <p style={{ marginTop: '0.75rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#64748b' }}>
              Reference: <strong>{error.digest}</strong>
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: '1.5rem',
              padding: '0.625rem 1rem',
              borderRadius: '0.5rem',
              background: '#0ea5e9',
              color: '#ffffff',
              border: 0,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
              minHeight: 44,
              minWidth: 44,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
