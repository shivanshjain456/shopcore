import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';
import { formatPhone } from '@/lib/utils/phone';

export const dynamic = 'force-dynamic';

export default async function AccountHome() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/account');

  const [orderCount, wishCount] = await Promise.all([
    prisma.order.count({ where: { userId: user.id } }),
    prisma.wishlistItem.count({ where: { userId: user.id } }),
  ]);
  const recentOrders = await prisma.order.findMany({
    where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 3,
  });

  return (
    <>
      {/* Phone Verification feature — non-blocking prompt for existing
          ACTIVE users who pre-date the phone-verify step. New signups
          can't reach this page without phoneVerified=true. */}
      {!user.phoneVerified && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Secure your account — verify your phone number
              </p>
              <p className="mt-1 text-xs text-amber-800">
                A verified mobile number protects your account and is required for some checkout features.
              </p>
            </div>
            <Link
              href="/verify-phone"
              className="tap-target inline-flex items-center justify-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
            >
              Verify phone
            </Link>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-wider text-brand-600">Customer dashboard</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Welcome, {user.firstName} {user.lastName}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {user.email} · {formatPhone(user.phone)}
          {user.phoneVerified && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">✓ Verified</span>}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Link href="/account/orders" className="rounded-xl border border-slate-200 p-4 hover:border-brand-300 hover:shadow-sm">
            <p className="text-xs uppercase text-slate-500">Orders</p>
            <p className="mt-1 text-2xl font-bold">{orderCount}</p>
          </Link>
          <Link href="/wishlist" className="rounded-xl border border-slate-200 p-4 hover:border-brand-300 hover:shadow-sm">
            <p className="text-xs uppercase text-slate-500">Wishlist</p>
            <p className="mt-1 text-2xl font-bold">{wishCount}</p>
          </Link>
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-xs uppercase text-slate-500">Loyalty points</p>
            <p className="mt-1 text-2xl font-bold">{user.loyaltyPoints}</p>
          </div>
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-xs uppercase text-slate-500">Referral code</p>
            <p className="mt-1 font-mono text-sm">{user.referralCode}</p>
          </div>
        </div>

        {recentOrders.length > 0 && (
          <section className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase text-slate-700">Recent orders</h2>
              <Link href="/account/orders" className="text-xs font-semibold text-brand-700 hover:underline">View all →</Link>
            </div>
            <ul className="mt-3 space-y-2">
              {recentOrders.map((o) => (
                <li key={o.id}>
                  <Link href={`/orders/${o.id}`} className="block rounded-lg border border-slate-200 p-3 hover:border-brand-300">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-mono text-sm font-semibold">{o.orderNumber}</p>
                        <p className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString('en-IN')} · {o.status.replace(/_/g, ' ')}</p>
                      </div>
                      <p className="text-sm font-bold">{rupees(o.totalPaise)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>
    </>
  );
}
