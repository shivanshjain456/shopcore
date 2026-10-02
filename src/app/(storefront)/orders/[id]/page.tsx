/**
 * Order detail page (also doubles as post-checkout confirmation when ?placed=1).
 * Server-rendered — secure by default (only the owner sees it).
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { rupees } from '@/lib/catalog/pricing';
import OrderActions from '@/components/orders/OrderActions';

export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<string, string> = {
  PENDING_PAYMENT_REVIEW: 'bg-amber-100 text-amber-800 border-amber-200',
  PAYMENT_VERIFIED:       'bg-blue-100 text-blue-800 border-blue-200',
  PAYMENT_REJECTED:       'bg-red-100 text-red-800 border-red-200',
  PROCESSING:             'bg-blue-100 text-blue-800 border-blue-200',
  PACKED:                 'bg-indigo-100 text-indigo-800 border-indigo-200',
  SHIPPED:                'bg-purple-100 text-purple-800 border-purple-200',
  OUT_FOR_DELIVERY:       'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  DELIVERED:              'bg-emerald-100 text-emerald-800 border-emerald-200',
  CANCELLED:              'bg-slate-100 text-slate-700 border-slate-200',
  RETURNED:               'bg-slate-100 text-slate-700 border-slate-200',
  REFUNDED:               'bg-slate-100 text-slate-700 border-slate-200',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT_REVIEW: 'Pending payment review',
  PAYMENT_VERIFIED:       'Payment verified',
  PAYMENT_REJECTED:       'Payment rejected',
  PROCESSING:             'Processing',
  PACKED:                 'Packed',
  SHIPPED:                'Shipped',
  OUT_FOR_DELIVERY:       'Out for delivery',
  DELIVERED:              'Delivered',
  CANCELLED:              'Cancelled',
  RETURNED:               'Returned',
  REFUNDED:               'Refunded',
};

export default async function OrderPage({
  params, searchParams,
}: { params: { id: string }; searchParams: { placed?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/orders/${params.id}`);

  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: {
      items: { include: { product: { select: { slug: true, images: { where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } } } } },
      statusHistory: { orderBy: { createdAt: 'asc' } },
      coupon: true,
    },
  });
  if (!order || order.userId !== user.id) notFound();

  const placed = searchParams.placed === '1';
  const addr = JSON.parse(order.addressSnapshot) as { shipping: { fullName: string; phone: string; addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string; country: string } };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <nav className="text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">Home</Link> /{' '}
        <Link href="/account/orders" className="hover:text-brand-700">My orders</Link> /{' '}
        <span className="text-slate-700">{order.orderNumber}</span>
      </nav>

      {placed && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900">
          <p className="text-sm font-bold uppercase tracking-wider">✓ Order placed</p>
          <h1 className="mt-1 text-2xl font-bold">Thank you! Order {order.orderNumber} received.</h1>
          <p className="mt-1 text-sm">
            We&apos;ve recorded your UTR and receipt. Our team will verify the payment, then start fulfilment.
            Once shipped, your courier name and tracking link will appear right here on this page.
          </p>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* Status + tracking */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Status</h2>
              <span className={`rounded-full border px-3 py-0.5 text-xs font-semibold ${STATUS_BADGE[order.status] ?? 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                {STATUS_LABEL[order.status] ?? order.status}
              </span>
            </div>

            {order.courierName || order.trackingNumber || order.trackingUrl ? (
              <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm">
                <p><span className="font-semibold">Courier:</span> {order.courierName ?? '—'}</p>
                {order.trackingNumber && <p><span className="font-semibold">Tracking #:</span> <code className="font-mono">{order.trackingNumber}</code></p>}
                {order.trackingUrl && (
                  <p className="mt-1">
                    <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer"
                       className="inline-block rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                      Track shipment ↗
                    </a>
                  </p>
                )}
              </div>
            ) : order.status !== 'CANCELLED' && (
              <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Courier and tracking will appear here once our team dispatches your package.
              </p>
            )}

            <ol className="mt-4 space-y-2">
              {order.statusHistory.map((h) => (
                <li key={h.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                  <div>
                    <p className="font-medium text-slate-900">{STATUS_LABEL[h.status] ?? h.status}</p>
                    {h.note && <p className="text-xs text-slate-500">{h.note}</p>}
                    <p className="text-[11px] text-slate-400">{new Date(h.createdAt).toLocaleString('en-IN')}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Items */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Items</h2>
            <div className="mt-3 space-y-3">
              {order.items.map((it) => (
                <div key={it.id} className="flex gap-3">
                  <Link href={`/p/${it.product.slug}`} className="block h-16 w-20 shrink-0 overflow-hidden rounded-md bg-slate-50">
                    {it.product.images[0]?.url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.product.images[0].url} alt={it.productName} className="h-full w-full object-cover" />
                    )}
                  </Link>
                  <div className="flex-1 text-sm">
                    <Link href={`/p/${it.product.slug}`} className="font-semibold text-slate-900 hover:text-brand-700">{it.productName}</Link>
                    {it.variantName && <p className="text-xs text-slate-500">{it.variantName}</p>}
                    <p className="text-xs text-slate-500">SKU {it.sku} · Qty {it.quantity} × {rupees(it.unitPricePaise)}</p>
                  </div>
                  <div className="text-right text-sm font-bold">{rupees(it.lineTotalPaise)}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Payment */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Payment</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Status</dt>
              <dd className="font-semibold">{order.paymentStatus.replace(/_/g, ' ')}</dd>
              <dt className="text-slate-500">Method</dt>
              <dd>UPI / QR</dd>
              <dt className="text-slate-500">Transaction ID (UTR)</dt>
              <dd className="font-mono">{order.utrNumber ?? '—'}</dd>
              <dt className="text-slate-500">Receipt</dt>
              <dd>{order.receiptUrl ? <a href={order.receiptUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 hover:underline">View receipt ↗</a> : '—'}</dd>
              {order.paymentRejectReason && (
                <>
                  <dt className="text-slate-500">Rejection note</dt>
                  <dd className="text-red-700">{order.paymentRejectReason}</dd>
                </>
              )}
            </dl>
            <p className="mt-3 text-xs">
              <Link href={`/orders/${order.id}/invoice`} className="font-semibold text-brand-700 hover:underline">
                View / download GST tax invoice ↗
              </Link>
            </p>
          </section>

          <OrderActions
            orderId={order.id}
            status={order.status}
            createdAt={order.createdAt.toISOString()}
          />
        </div>

        {/* Summary aside */}
        <aside className="h-fit space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Totals</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd>{rupees(order.subtotalPaise)}</dd></div>
              {order.discountPaise > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <dt>Coupon {order.coupon?.code ? `(${order.coupon.code})` : ''}</dt>
                  <dd>− {rupees(order.discountPaise)}</dd>
                </div>
              )}
              <div className="flex justify-between"><dt className="text-slate-600">Shipping</dt><dd>{order.shippingPaise === 0 ? 'FREE' : rupees(order.shippingPaise)}</dd></div>
              <div className="flex justify-between text-xs text-slate-500"><dt>Includes GST</dt><dd>{rupees(order.taxPaise)}</dd></div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold"><dt>Total paid</dt><dd>{rupees(order.totalPaise)}</dd></div>
            </dl>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Ships to</h2>
            <p className="mt-2 text-sm font-semibold">{addr.shipping.fullName}</p>
            <p className="text-sm text-slate-700">{addr.shipping.addressLine1}</p>
            <p className="text-sm text-slate-700">{addr.shipping.addressLine2}</p>
            <p className="text-sm text-slate-700">{addr.shipping.city}, {addr.shipping.state} — {addr.shipping.pinCode}</p>
            <p className="text-sm text-slate-700">{addr.shipping.country}</p>
            <p className="mt-1 text-sm text-slate-500">{addr.shipping.phone}</p>
            {order.gstinAtOrder && <p className="mt-2 text-xs text-slate-500">GSTIN: <code className="font-mono">{order.gstinAtOrder}</code></p>}
          </section>
        </aside>
      </div>
    </main>
  );
}
