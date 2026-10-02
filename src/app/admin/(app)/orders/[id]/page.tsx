'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Order {
  id: string; orderNumber: string; status: string; paymentStatus: string;
  subtotalPaise: number; discountPaise: number; shippingPaise: number; taxPaise: number; totalPaise: number;
  utrNumber: string | null; receiptUrl: string | null; paymentRejectReason: string | null;
  courierName: string | null; trackingNumber: string | null; trackingUrl: string | null;
  customerNote: string | null; internalNote: string | null;
  isB2B: boolean; gstinAtOrder: string | null;
  addressSnapshot: string;
  createdAt: string;
  items: { id: string; productName: string; variantName: string | null; sku: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }[];
  statusHistory: { id: string; status: string; note: string | null; createdAt: string }[];
  user: { email: string; firstName: string; lastName: string; phone: string; companyName: string | null; gstin: string | null; role: string };
}

export default function AdminOrderDetail() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const router = useRouter();
  const [o, setO] = useState<Order | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ order: Order }>(`/api/admin/orders/${id}`);
    if (r.ok && r.data) setO(r.data.order);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function verify() {
    // 3-step attestation flow (Bug #6 contract preserved):
    //   1. Confirm the bank-statement amount matches.
    //   2. (Optional) Type the UTR shown in the bank statement for a cross-check.
    //   3. (Optional) Add a verification note.
    // Cancelling any step aborts the whole verify with no API call.
    if (!o) return;
    const confirmed = await dialog.confirm({
      title: 'Bank-statement check',
      message: `Have you confirmed that ₹${(o.totalPaise / 100).toLocaleString('en-IN')} was credited to the business account against UTR ${o.utrNumber ?? '(none)'}?\n\nClick "Attest & continue" to declare amountMatches = true. Click Cancel to abort.`,
      intent: 'warning', confirmLabel: 'Attest & continue', cancelLabel: 'Abort verify',
    });
    if (!confirmed) { setMsg('Verify aborted — admin did not attest amount match.'); return; }
    const bankRef = await dialog.promptUser({
      title: 'Cross-check UTR',
      message: "Enter the UTR as shown in your bank statement. Leave blank to skip the cross-check (not recommended).",
      defaultValue: o.utrNumber ?? '',
      placeholder: '12-digit UPI ref / NEFT or RTGS UTR',
      maxLength: 32,
      confirmLabel: 'Continue', cancelLabel: 'Abort verify',
    });
    if (bankRef === null) { setMsg('Verify aborted at bank-reference step.'); return; }
    const note = await dialog.promptUser({
      title: 'Verification note (optional)',
      message: 'Anything to record for audit — bank statement entry, time, source, etc.',
      placeholder: 'e.g. ICICI statement 2026-06-03 14:21',
      multiline: true, maxLength: 300,
      confirmLabel: 'Verify payment', cancelLabel: 'Abort verify',
    });
    if (note === null) { setMsg('Verify aborted at note step.'); return; }
    const r = await api(`/api/admin/orders/${id}/verify-payment`, {
      method: 'POST',
      body: { amountMatches: true, bankReference: bankRef || null, note: note || null },
    });
    if (!r.ok) { await dialog.alert({ title: 'Verify failed', message: r.error ?? 'Please try again.' }); return; }
    setMsg('Payment verified.'); await load();
  }
  async function reject() {
    const reason = await dialog.promptUser({
      title: 'Reject payment',
      message: 'Why was this payment rejected? The customer will see this reason. Stock will be restored.',
      placeholder: 'e.g. UTR not found in bank statement', required: true,
      multiline: true, maxLength: 500,
      intent: 'destructive', confirmLabel: 'Reject payment',
    });
    if (reason === null) return;
    const r = await api(`/api/admin/orders/${id}/reject-payment`, { method: 'POST', body: { reason, restoreStock: true } });
    if (!r.ok) { await dialog.alert({ title: 'Reject failed', message: r.error ?? 'Please try again.' }); return; }
    setMsg('Payment rejected.'); await load();
  }
  async function advance(to: string) {
    const note = await dialog.promptUser({
      title: `Move order to ${to}`,
      message: 'Optional note to attach to the status change (visible to the customer).',
      placeholder: 'e.g. Packed and handed over to courier',
      multiline: true, maxLength: 300,
      confirmLabel: 'Update status',
    });
    if (note === null) return;
    const r = await api(`/api/admin/orders/${id}/status`, { method: 'POST', body: { to, note: note || undefined } });
    if (!r.ok) { await dialog.alert({ title: 'Status change failed', message: r.error ?? 'Please try again.' }); return; }
    setMsg(`Moved to ${to}.`); await load();
  }
  async function refund() {
    const reason = await dialog.promptUser({
      title: 'Refund order',
      message: 'Why is this order being refunded? Stock will be restored.',
      placeholder: 'e.g. Customer cancelled after dispatch',
      required: true, multiline: true, maxLength: 500,
      intent: 'destructive', confirmLabel: 'Refund order',
    });
    if (reason === null) return;
    const r = await api(`/api/admin/orders/${id}/refund`, { method: 'POST', body: { reason, restoreStock: true } });
    if (!r.ok) { await dialog.alert({ title: 'Refund failed', message: r.error ?? 'Please try again.' }); return; }
    setMsg('Refunded.'); await load();
  }
  async function saveShipping(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await api(`/api/admin/orders/${id}/shipping`, {
      method: 'POST', body: {
        courierName: String(f.get('courierName') ?? ''),
        trackingNumber: String(f.get('trackingNumber') ?? '') || null,
        trackingUrl: String(f.get('trackingUrl') ?? '') || null,
      },
    });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg('Shipping saved.'); await load();
  }

  if (!o) return <p className="text-sm text-slate-500">Loading…</p>;

  const addr = JSON.parse(o.addressSnapshot) as { shipping: { fullName: string; phone: string; addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string } };

  return (
    <>
      <PageHeader
        title={o.orderNumber}
        subtitle={`${o.isB2B ? 'B2B · ' : ''}${o.user.email} · ${new Date(o.createdAt).toLocaleString('en-IN')}`}
        actions={<Link href={`/orders/${o.id}/invoice`} target="_blank" rel="noopener noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">View invoice ↗</Link>}
      />
      {msg && <p className="mb-3 rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{msg}</p>}

      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <Card>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase text-slate-700">Status</h2>
              <div className="flex gap-2"><StatusBadge s={o.status} /><StatusBadge s={o.paymentStatus} /></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {o.paymentStatus === 'AWAITING_VERIFICATION' && <>
                <Button tone="primary" onClick={verify}>Verify payment</Button>
                <Button tone="danger"  onClick={reject}>Reject payment</Button>
              </>}
              {['PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY'].includes(o.status) && (
                <Button tone="amber" onClick={() => {
                  const next = { PROCESSING: 'PACKED', PACKED: 'SHIPPED', SHIPPED: 'OUT_FOR_DELIVERY', OUT_FOR_DELIVERY: 'DELIVERED' }[o.status as 'PROCESSING'|'PACKED'|'SHIPPED'|'OUT_FOR_DELIVERY'];
                  advance(next);
                }}>Advance to next status</Button>
              )}
              {o.paymentStatus === 'VERIFIED' && o.status !== 'REFUNDED' && o.status !== 'CANCELLED' && (
                <Button tone="danger" onClick={refund}>Refund</Button>
              )}
            </div>
            <ol className="mt-4 space-y-1.5 text-xs">
              {o.statusHistory.map((h) => (
                <li key={h.id} className="flex gap-2 border-b border-slate-100 pb-1">
                  <span className="font-semibold">{h.status}</span>
                  <span className="text-slate-600">{h.note}</span>
                  <span className="ml-auto text-slate-400">{new Date(h.createdAt).toLocaleString('en-IN')}</span>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-bold uppercase text-slate-700">Courier &amp; tracking</h2>
            <form onSubmit={saveShipping} className="grid gap-2 md:grid-cols-3">
              <input name="courierName"   defaultValue={o.courierName ?? ''}   placeholder="Courier name (e.g. Delhivery)" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm md:col-span-1" required />
              <input name="trackingNumber" defaultValue={o.trackingNumber ?? ''} placeholder="Tracking number"               className="rounded-md border border-slate-300 px-3 py-1.5 text-sm md:col-span-1" />
              <input name="trackingUrl"   defaultValue={o.trackingUrl ?? ''}   placeholder="https://courier.com/track/123" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm md:col-span-1" />
              <Button type="submit" className="md:col-span-3">Save shipping</Button>
            </form>
            <p className="mt-2 text-xs text-slate-500">Saving fields here also reveals them on the customer&apos;s order page.</p>
          </Card>

          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Items</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">Item</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Unit</th><th className="px-2 py-1 text-right">Line</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {o.items.map((it) => (
                  <tr key={it.id}><td className="px-2 py-1">{it.productName}{it.variantName ? ' · ' + it.variantName : ''}<br/><span className="font-mono text-[10px] text-slate-500">{it.sku}</span></td><td className="px-2 py-1 text-right">{it.quantity}</td><td className="px-2 py-1 text-right">{rupees(it.unitPricePaise)}</td><td className="px-2 py-1 text-right font-semibold">{rupees(it.lineTotalPaise)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Payment proof</h2>
            <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-slate-500">UTR</dt><dd className="font-mono">{o.utrNumber ?? '—'}</dd>
              <dt className="text-slate-500">Receipt</dt><dd>{o.receiptUrl ? <a href={o.receiptUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 hover:underline">View ↗</a> : '—'}</dd>
              {o.paymentRejectReason && <><dt className="text-slate-500">Reject reason</dt><dd className="text-red-700">{o.paymentRejectReason}</dd></>}
            </dl>
          </Card>
        </div>

        <aside className="h-fit space-y-3">
          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Totals</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="Subtotal" v={rupees(o.subtotalPaise)} />
              {o.discountPaise > 0 && <Row label="Discount" v={`− ${rupees(o.discountPaise)}`} />}
              <Row label="Shipping" v={o.shippingPaise === 0 ? 'FREE' : rupees(o.shippingPaise)} />
              <Row label="Of which tax" v={rupees(o.taxPaise)} small />
              <Row label="Total" v={rupees(o.totalPaise)} bold />
            </dl>
          </Card>
          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Customer</h2>
            <p className="mt-2 text-sm font-semibold">{o.user.companyName ?? `${o.user.firstName} ${o.user.lastName}`}</p>
            <p className="text-xs">{o.user.email}<br/>{o.user.phone}</p>
            {o.gstinAtOrder && <p className="mt-1 text-xs">GSTIN: <code className="font-mono">{o.gstinAtOrder}</code></p>}
          </Card>
          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Ships to</h2>
            <p className="mt-2 text-sm">{addr.shipping.fullName}<br/>{addr.shipping.addressLine1}<br/>{addr.shipping.addressLine2}<br/>{addr.shipping.city}, {addr.shipping.state} — {addr.shipping.pinCode}<br/>{addr.shipping.phone}</p>
          </Card>
          {o.customerNote && <Card><h2 className="text-sm font-bold uppercase text-slate-700">Customer note</h2><p className="mt-1 text-sm">{o.customerNote}</p></Card>}
        </aside>
      </div>
    </>
  );
}

function Row({ label, v, bold, small }: { label: string; v: string; bold?: boolean; small?: boolean }) {
  return (
    <div className={`flex justify-between ${small ? 'text-xs text-slate-500' : ''}`}>
      <dt>{label}</dt><dd className={bold ? 'border-t border-slate-200 pt-1 font-bold' : ''}>{v}</dd>
    </div>
  );
}
