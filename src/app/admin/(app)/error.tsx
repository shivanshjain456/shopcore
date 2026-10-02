'use client';
/**
 * Admin-segment error page. Catches server-component errors inside any
 * `/admin/(app)/*` route. Renders within the admin shell layout so the
 * sidebar + topbar stay visible.
 */
import { useEffect } from 'react';
import AdminErrorFallback from '@/components/admin/AdminErrorFallback';

export default function AdminSegmentError({
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
          path: typeof window !== 'undefined' ? window.location.pathname : '',
          source: 'admin-segment-error',
        }),
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch { /* */ }
  }, [error]);

  return <AdminErrorFallback error={error} reset={reset} />;
}
