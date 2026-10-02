import SideNav from '@/components/account/SideNav';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="h-fit rounded-xl border border-slate-200 bg-white p-3">
          <p className="px-3 pb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Account</p>
          <SideNav />
        </aside>
        <section>{children}</section>
      </div>
    </main>
  );
}
