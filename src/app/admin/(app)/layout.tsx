import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import BackButtonGuard from '@/components/auth/BackButtonGuard';
import AdminShell from '@/components/admin/AdminShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import AdminErrorFallback from '@/components/admin/AdminErrorFallback';

/**
 * Admin shell layout. The `/admin/login` page lives at /admin/login and intentionally
 * does NOT pass through this layout (we check pathname via the URL itself).
 *
 * Auth: requires the dedicated sc_admin cookie + ACTIVE admin user.
 * Layout: server component (this file) does the auth gate; the actual
 *         chrome is in a CLIENT component (`<AdminShell>`) so the responsive
 *         mobile drawer can use React state + matchMedia. — Feature #14.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser({ requireAdmin: true });
  if (!user) {
    // For any admin page except /login, middleware already redirects to /admin/login;
    // this layer is the safety net for direct hits.
    redirect('/admin/login');
  }
  return (
    <>
      <BackButtonGuard />
      <AdminShell email={user.email}>
        {/*
          Page-level boundary inside the shell — sidebar / topbar stay
          up if a single admin page errors. Server-component errors
          in `/admin/(app)/**` are caught by the segment `error.tsx`
          instead; this catches CLIENT-component render errors.

          Static-fallback form (not render-prop) — this layout is a
          server component, so we cannot pass a function across the
          server/client boundary into <ErrorBoundary>. AdminErrorFallback
          receives no error/reset args here; the segment `error.tsx`
          page is the surface that gets the full {error, reset} pair.
        */}
        <ErrorBoundary fallback={<AdminErrorFallback />}>
          {children}
        </ErrorBoundary>
      </AdminShell>
    </>
  );
}
