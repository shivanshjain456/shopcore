import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { getB2BProfile } from '@/lib/b2b/apply';
import B2BSideNav from '@/components/b2b/SideNav';

/**
 * Layout for the authenticated B2B surface (dashboard, quotes, bulk).
 * The public landing (`/b2b`) and apply (`/b2b/apply`) pages live OUTSIDE the
 * storefront route group, so they don't pass through here.
 */
export default async function B2BLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/b2b/dashboard');
  const profile = await getB2BProfile(user.id);
  if (profile?.status !== 'APPROVED') redirect('/b2b/apply');

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="h-fit rounded-xl border border-slate-200 bg-white p-3">
          <p className="px-3 pb-2 text-xs font-bold uppercase tracking-wider text-slate-500">B2B</p>
          <B2BSideNav />
        </aside>
        <section>{children}</section>
      </div>
    </main>
  );
}
