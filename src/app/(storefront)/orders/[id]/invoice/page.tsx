/**
 * GST tax invoice — self-contained printable HTML page.
 * Owner-only (or admin); B2B orders show GSTIN row.
 * Use the browser's "Print to PDF" to get a PDF copy.
 */
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { rupees, rupeesDecimal } from '@/lib/catalog/pricing';
import { maskUtr } from '@/lib/checkout/utr';
import InvoiceFooter from '@/components/orders/InvoiceFooter';

export const dynamic = 'force-dynamic';

export default async function InvoicePage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/orders/${params.id}/invoice`);
  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: { items: true, user: true },
  });
  if (!order) notFound();
  if (order.userId !== user.id && user.role !== 'ADMIN') notFound();

  const addr = JSON.parse(order.addressSnapshot) as {
    shipping: { fullName: string; phone: string; addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string; country: string };
  };

  // Per-line ex-tax breakdown (CGST + SGST split for intra-state, IGST for inter-state)
  const sellerState = process.env.NEXT_PUBLIC_SELLER_STATE ?? 'Maharashtra'; // configurable later via StoreConfig
  const isInterstate = addr.shipping.state !== sellerState;

  return (
    <main className="mx-auto max-w-4xl bg-white p-8 text-slate-900 print:p-0">
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="flex items-start justify-between border-b border-slate-300 pb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500">Tax invoice</p>
          <h1 className="text-2xl font-extrabold">{process.env.PAYMENT_DISPLAY_NAME ?? 'ShopCore'}</h1>
          <p className="text-xs text-slate-600">India · ships pan-India</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-bold">{order.orderNumber}</p>
          <p className="text-xs text-slate-500">Order placed: {new Date(order.createdAt).toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Invoice generated: {new Date().toLocaleString('en-IN')}</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Bill to</p>
          <p className="font-semibold">{order.isB2B ? (order.user.companyName ?? `${order.user.firstName} ${order.user.lastName}`) : `${order.user.firstName} ${order.user.lastName}`}</p>
          {order.gstinAtOrder && <p className="font-mono text-xs">GSTIN: {order.gstinAtOrder}</p>}
          <p>{order.user.email}</p>
          <p>{order.user.phone}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Ship to</p>
          <p className="font-semibold">{addr.shipping.fullName}</p>
          <p>{addr.shipping.addressLine1}</p>
          <p>{addr.shipping.addressLine2}</p>
          <p>{addr.shipping.city}, {addr.shipping.state} — {addr.shipping.pinCode}</p>
          <p>{addr.shipping.country}</p>
          <p>{addr.shipping.phone}</p>
        </div>
      </div>

      <table className="mt-6 w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-slate-300 bg-slate-50 text-left text-xs uppercase">
            <th className="p-2">#</th>
            <th className="p-2">Item</th>
            <th className="p-2">HSN</th>
            <th className="p-2 text-right">Qty</th>
            <th className="p-2 text-right">Unit ex-tax</th>
            <th className="p-2 text-right">Taxable</th>
            <th className="p-2 text-right">{isInterstate ? 'IGST' : 'CGST + SGST'}</th>
            <th className="p-2 text-right">Line total</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((it, idx) => {
            const taxable = it.lineTotalPaise - it.taxPaise;
            return (
              <tr key={it.id} className="border-b border-slate-100 align-top">
                <td className="p-2">{idx + 1}</td>
                <td className="p-2">
                  <p className="font-semibold">{it.productName}</p>
                  {it.variantName && <p className="text-xs text-slate-500">{it.variantName}</p>}
                  <p className="text-xs text-slate-500">SKU {it.sku}</p>
                </td>
                <td className="p-2 font-mono text-xs">—</td>
                <td className="p-2 text-right">{it.quantity}</td>
                <td className="p-2 text-right">{rupeesDecimal(Math.round((it.unitPricePaise) / (1 + it.gstRate / 100)))}</td>
                <td className="p-2 text-right">{rupeesDecimal(taxable)}</td>
                <td className="p-2 text-right">
                  {isInterstate
                    ? `${rupeesDecimal(it.taxPaise)} (${it.gstRate}%)`
                    : `${rupeesDecimal(Math.round(it.taxPaise / 2))} + ${rupeesDecimal(it.taxPaise - Math.round(it.taxPaise / 2))} (${it.gstRate / 2}% + ${it.gstRate / 2}%)`}
                </td>
                <td className="p-2 text-right font-semibold">{rupeesDecimal(it.lineTotalPaise)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div className="text-xs text-slate-500">
          <p>Payment status: <strong>{order.paymentStatus.replace(/_/g, ' ')}</strong></p>
          {order.utrNumber && <p>UTR: <code className="font-mono">{user.role === 'ADMIN' ? order.utrNumber : maskUtr(order.utrNumber)}</code></p>}
          {order.courierName && <p>Courier: {order.courierName}{order.trackingNumber ? ` · #${order.trackingNumber}` : ''}</p>}
        </div>
        <dl className="space-y-1 text-right">
          <div className="flex justify-between"><dt>Subtotal (incl. tax)</dt><dd>{rupeesDecimal(order.subtotalPaise)}</dd></div>
          {order.discountPaise > 0 && <div className="flex justify-between text-emerald-700"><dt>Discount</dt><dd>− {rupeesDecimal(order.discountPaise)}</dd></div>}
          <div className="flex justify-between"><dt>Shipping</dt><dd>{order.shippingPaise === 0 ? 'FREE' : rupeesDecimal(order.shippingPaise)}</dd></div>
          <div className="flex justify-between text-xs text-slate-500"><dt>Of which tax</dt><dd>{rupeesDecimal(order.taxPaise)}</dd></div>
          <div className="flex justify-between border-t border-slate-300 pt-2 text-base font-bold"><dt>Grand total</dt><dd>{rupees(order.totalPaise)}</dd></div>
        </dl>
      </div>

      <p className="mt-8 text-center text-[10px] text-slate-500">
        This is a computer-generated tax invoice. {isInterstate ? 'Inter-state supply — IGST applies.' : 'Intra-state supply — CGST + SGST applies.'} Goods sold are non-returnable beyond the configured policy window.
      </p>

      <InvoiceFooter orderId={order.id} />
    </main>
  );
}
