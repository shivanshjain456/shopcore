import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';
import ReorderButton from '@/components/orders/ReorderButton';
import { parsePaginationParams, buildPagination } from '@/lib/pagination';
import { getStoreConfig } from '@/lib/storeConfig';
import Pagination from '@/components/Pagination';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT_REVIEW: 'Pending payment review',
  PAYMENT_VERIFIED: 'Payment verified', PAYMENT_REJECTED: 'Payment rejected',
  PROCESSING: 'Processing', PACKED: 'Packed', SHIPPED: 'Shipped',
  OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled', RETURNED: 'Returned', REFUNDED: 'Refunded',
};

export default async function OrdersList({
  searchParams,
}: {
  searchParams: { page?: string; pageSize?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/account/orders');

  // Item 12 — URL-driven pagination (page state lives in the URL so
  // back/forward + share-the-URL work natively).
  const config = await getStoreConfig();
  const { page, pageSize, skip, take } = parsePaginationParams(
    searchParams, config, { defaultPageSize: 10 },
  );
  const where = { userId: user.id };
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take,
      include: { items: true },
    }),
  ]);
  const { pagination } = buildPagination(orders, total, page, pageSize);

  // Spec §2.8 — page > totalPages: redirect to page 1 with the same
  // filters (only `pageSize` to preserve here).
  if (pagination.total > 0 && page > pagination.totalPages) {
    const qs = new URLSearchParams();
    qs.set('page', '1');
    if (searchParams.pageSize) qs.set('pageSize', String(searchParams.pageSize));
    redirect(`/account/orders?${qs.toString()}`);
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">My orders</h1>
      <p className="text-sm text-slate-600">{total} order{total === 1 ? '' : 's'}</p>

      {total === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="font-semibold">No orders yet.</p>
          <Link href="/" className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Start shopping</Link>
        </div>
      ) : (
        <>
          <ul className="mt-6 space-y-3">
            {orders.map((o) => (
              <li key={o.id}>
                <div className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <Link href={`/orders/${o.id}`} className="font-mono text-sm font-semibold text-slate-900 hover:text-brand-700">{o.orderNumber}</Link>
                      <p className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString('en-IN')} · {o.items.length} item{o.items.length === 1 ? '' : 's'}</p>
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <div>
                        <p className="text-sm font-bold">{rupees(o.totalPaise)}</p>
                        <p className="text-xs text-slate-600">{STATUS_LABEL[o.status] ?? o.status}</p>
                        {o.courierName && <p className="text-xs text-slate-500">Courier: {o.courierName}</p>}
                      </div>
                      <div className="flex flex-col gap-1">
                        <Link href={`/orders/${o.id}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">View</Link>
                        <ReorderButton orderId={o.id} />
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            currentPage={pagination.page}
            totalPages={pagination.totalPages}
            pageSize={pagination.pageSize}
            totalItems={pagination.total}
            basePath="/account/orders"
            searchParams={searchParams}
          />
        </>
      )}
    </>
  );
}
