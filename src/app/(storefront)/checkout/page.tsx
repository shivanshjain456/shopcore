'use client';
/**
 * Single-page checkout with three vertical sections:
 *   1. Shipping address (pick existing / add new)
 *   2. Order summary + coupon
 *   3. Payment: QR + UTR + receipt upload + Submit
 *
 * All money is recomputed server-side. Submit is disabled until UTR + receipt are valid.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';
import { rupees } from '@/lib/catalog/pricing';
import { INDIAN_STATES } from '@/lib/enums';
import PincodeField from '@/components/forms/PincodeField';
import PhoneField   from '@/components/forms/PhoneField';
import { formatPhone } from '@/lib/utils/phone';

interface Address {
  id: string; label: string | null; fullName: string; phone: string;
  addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string; country: string;
  isDefault: boolean;
}

interface SummaryResp {
  totals: {
    subtotalPaise: number; discountPaise: number; loyaltyDiscountPaise: number; loyaltyPointsUsed: number;
    shippingPaise: number; taxPaise: number; totalPaise: number;
    freeShippingApplied: boolean; couponCode: string | null; couponError: string | null; loyaltyError: string | null;
    items: { productName: string; variantName: string | null; quantity: number; unitPricePaise: number; lineTotalPaise: number; gstRate: number; taxPaise: number; }[];
  };
  config: { paymentUpiId: string; paymentDisplay: string; maxReceiptMb: number; shipping: { freeShippingMinPaise: number; defaultShippingPaise: number }; loyalty: { enabled: boolean; redeemValuePaise: number } };
  addresses: Address[];
  user: { isB2B: boolean; gstin: string | null; loyaltyPoints: number };
}

/** Buy-Now mode: when the URL carries ?express=1, the checkout summary +
 *  place-order calls use `source=express` so the user's Cart is bypassed
 *  in favour of their ExpressCheckout row. The user's regular cart is
 *  preserved across the entire flow.
 *
 *  Because we call useSearchParams() (to read `?express=1`), Next requires
 *  this component to be inside a Suspense boundary; see the default export
 *  at the bottom of this file. */
function CheckoutPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  /** True iff the user arrived here from a "Buy Now" click. Drives the
   *  source=express query-param on summary + place-order. */
  const isExpress = params.get('express') === '1';
  const dialog = useDialog();
  const [data, setData] = useState<SummaryResp | null>(null);
  const [coupon, setCoupon] = useState('');
  const [couponApplied, setCouponApplied] = useState<string | null>(null);
  const [addressId, setAddressId] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

  // Feature #13 — controlled state for the address form's autofill-aware
  // fields. Pre-existing FormData usage continues to read `label`,
  // `fullName`, `phone`, `addressLine1`, `addressLine2` via the form.
  const [newCity, setNewCity]       = useState('');
  const [newState, setNewState]     = useState('');
  const [newPinCode, setNewPinCode] = useState('');
  // Item 9 — phone is now controlled (PhoneField composes E.164).
  const [newPhone, setNewPhone]     = useState('');

  const [redeem, setRedeem] = useState(0);
  const [utr, setUtr] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'UPI' | 'IMPS' | 'NEFT' | 'RTGS'>('UPI');
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [gstin, setGstin] = useState('');

  const load = async (couponCode?: string | null, redeemPts?: number) => {
    const qs = new URLSearchParams();
    if (couponCode) qs.set('coupon', couponCode);
    if (redeemPts && redeemPts > 0) qs.set('redeem', String(redeemPts));
    if (isExpress) qs.set('source', 'express');
    const r = await api<SummaryResp>(`/api/checkout/summary${qs.toString() ? `?${qs.toString()}` : ''}`);
    if (!r.ok) {
      if (r.status === 401) router.push(`/login?next=${encodeURIComponent('/checkout' + (isExpress ? '?express=1' : ''))}`);
      return;
    }
    setData(r.data ?? null);
    if (r.data?.addresses?.length && !addressId) {
      const def = r.data.addresses.find((a) => a.isDefault) ?? r.data.addresses[0];
      setAddressId(def.id);
    }
    if (r.data?.user.gstin && !gstin) setGstin(r.data.user.gstin);
  };

  useEffect(() => { void load(couponApplied, redeem); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [couponApplied, redeem]);

  const itemCount = useMemo(() => data?.totals.items.reduce((s, i) => s + i.quantity, 0) ?? 0, [data]);

  // Send users with empty carts away
  useEffect(() => {
    if (data && itemCount === 0) router.push('/cart');
  }, [data, itemCount, router]);

  async function applyCoupon() {
    const code = coupon.trim().toUpperCase();
    if (!code) return;
    setCouponApplied(code);
  }
  function removeCoupon() { setCoupon(''); setCouponApplied(null); }

  async function addAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setAddBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await api<{ address: Address }>('/api/addresses', {
      method: 'POST',
      body: {
        label: String(f.get('label') ?? ''),
        fullName: String(f.get('fullName') ?? ''),
        // Item 9: controlled (PhoneField composes E.164 for us).
        phone: newPhone,
        addressLine1: String(f.get('addressLine1') ?? ''),
        addressLine2: String(f.get('addressLine2') ?? ''),
        // Feature #13: controlled (pincode-autofill aware).
        city: newCity,
        state: newState,
        pinCode: newPinCode,
        country: 'India',
      },
    });
    setAddBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Could not save address', message: r.error ?? 'Please try again.' }); return; }
    setShowAddForm(false);
    // Reset Feature #13 + Item 9 controlled fields after a successful save.
    setNewCity(''); setNewState(''); setNewPinCode(''); setNewPhone('');
    await load(couponApplied);
    if (r.data?.address.id) setAddressId(r.data.address.id);
  }

  async function uploadReceipt(file: File) {
    setUploadErr(null);
    setUploadBusy(true);
    try {
      const csrf = document.cookie.match(/(?:^|; )sc_csrf=([^;]*)/)?.[1];
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/api/checkout/upload-receipt', {
        method: 'POST',
        headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {},
        body: fd, credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({} as { error?: string; data?: { url: string } }));
      if (!res.ok || !json.ok) { setUploadErr((json as { error?: string }).error ?? 'Upload failed.'); return; }
      setReceiptUrl((json as { data: { url: string } }).data.url);
      setReceiptName(file.name);
    } finally { setUploadBusy(false); }
  }

  // Stable across retries of the SAME submit attempt — server uses it to
  // deduplicate (double-click, network retry, refresh). A new one is minted
  // every time the user enters checkout afresh.
  const [idemKey, setIdemKey] = useState<string>(() => newIdempotencyKey());

  async function submit() {
    setSubmitErr(null);
    if (!addressId) { setSubmitErr('Please select a shipping address.'); return; }
    if (!utrLooksOk) { setSubmitErr(`Enter a valid ${paymentMethod} Transaction ID (UTR).`); return; }
    if (!receiptUrl) { setSubmitErr('Upload your payment receipt.'); return; }
    if (submitBusy) return;                       // local double-click guard
    setSubmitBusy(true);
    try {
      const r = await api<{ orderId: string; orderNumber: string }>('/api/checkout/place-order', {
        method: 'POST',
        idempotencyKey: idemKey,                  // server dedupes on this
        body: {
          shippingAddressId: addressId,
          couponCode: couponApplied ?? null,
          redeemPoints: redeem > 0 ? redeem : null,
          paymentMethod,
          utrNumber: utr.trim(),
          receiptUrl,
          customerNote: note.trim() || null,
          gstinAtOrder: data?.user.isB2B ? (gstin.trim() || null) : null,
          // Carry the source through so placeOrder() uses the express row
          // instead of the cart. Server-side validation is unchanged.
          source: isExpress ? 'express' : 'cart',
        },
      });
      if (!r.ok) {
        // 409 = fingerprint conflict; mint a fresh key so the user can change
        // the payload and retry. All other errors keep the same key so a
        // retry truly retries (and the server returns the cached failure).
        if (r.status === 409) setIdemKey(newIdempotencyKey());
        setSubmitErr(r.error ?? 'Could not place order.');
        return;
      }
      router.push(`/orders/${r.data?.orderId}?placed=1`);
    } finally {
      setSubmitBusy(false);
    }
  }

  if (!data) {
    return <main className="mx-auto max-w-5xl px-4 py-16 text-center text-sm text-slate-500">Loading checkout…</main>;
  }

  const t = data.totals;
  // Client-side hint only — server is authoritative (see lib/checkout/utr.ts).
  const sanitisedUtr = utr.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const utrLooksOk =
    paymentMethod === 'UPI'  || paymentMethod === 'IMPS' ? /^\d{12}$/.test(sanitisedUtr) :
    paymentMethod === 'NEFT' ? /^[A-Z]{4}N\d{11}$/.test(sanitisedUtr) :
    /^[A-Z]{4}R\d{11,17}$/.test(sanitisedUtr);
  const canSubmit = !!addressId && utrLooksOk && !!receiptUrl && !submitBusy;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-slate-900">Checkout</h1>
        {isExpress && (
          <span
            data-testid="express-banner"
            className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-800"
          >
            Express checkout · Buy now
          </span>
        )}
      </div>
      <p className="text-sm text-slate-600">{itemCount} item{itemCount === 1 ? '' : 's'} · ships across India</p>
      {isExpress && (
        <p className="mt-1 text-xs text-slate-500">
          You&apos;re buying this item directly — your regular cart is preserved.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* LEFT */}
        <div className="space-y-6">
          {/* 1. Address */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">1 · Shipping address</h2>
              <button onClick={() => setShowAddForm((s) => !s)} className="text-xs font-semibold text-brand-700 hover:underline">
                {showAddForm ? 'Cancel' : '+ Add new'}
              </button>
            </div>

            <div className="mt-3 grid gap-2">
              {data.addresses.map((a) => (
                <label key={a.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${addressId === a.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-brand-300'}`}>
                  <input type="radio" name="addr" className="mt-1" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                  <div className="text-sm">
                    <p className="font-semibold text-slate-900">
                      {a.fullName} {a.label && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-600">{a.label}</span>}
                    </p>
                    <p className="text-slate-700">{a.addressLine1}, {a.addressLine2}</p>
                    <p className="text-slate-700">{a.city}, {a.state} — {a.pinCode}, {a.country}</p>
                    <p className="text-slate-500">{formatPhone(a.phone)}</p>
                  </div>
                </label>
              ))}
              {data.addresses.length === 0 && (
                <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                  No saved addresses yet. Add one to continue.
                </p>
              )}
            </div>

            {showAddForm && (
              <form onSubmit={addAddress} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input name="label" placeholder="Label (Home / Office)" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
                <input name="fullName" required placeholder="Full name" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
                {/* Item 9 — locked +91 prefix, 10-digit input. */}
                <div>
                  <PhoneField
                    label="Phone"
                    value={newPhone}
                    onChange={setNewPhone}
                    required
                  />
                </div>
                <input name="addressLine1" required placeholder="Address line 1" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
                <input name="addressLine2" required placeholder="Address line 2" className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2" />
                <input
                  value={newCity}
                  onChange={(e) => setNewCity(e.target.value)}
                  required placeholder="City"
                  data-testid="checkout-city"
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <select
                  value={newState}
                  onChange={(e) => setNewState(e.target.value)}
                  required
                  data-testid="checkout-state"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="" disabled>State</option>
                  {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <div className="sm:col-span-2">
                  <PincodeField
                    value={newPinCode}
                    onChange={setNewPinCode}
                    onAutofill={(a) => {
                      if (!newCity.trim() && a.city) setNewCity(a.city);
                      if (!newState && a.state)      setNewState(a.state);
                    }}
                    data-testid="checkout-pincode"
                  />
                </div>
                <button disabled={addBusy} type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 sm:col-span-2">
                  {addBusy ? 'Saving…' : 'Save address'}
                </button>
              </form>
            )}
          </section>

          {/* 2. Coupon + items */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">2 · Order review</h2>

            <div className="mt-3 space-y-2 text-sm">
              {t.items.map((i, idx) => (
                <div key={idx} className="flex items-start justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0">
                  <div>
                    <p className="font-medium text-slate-900">{i.productName} {i.variantName && <span className="text-slate-500">· {i.variantName}</span>}</p>
                    <p className="text-xs text-slate-500">Qty {i.quantity} × {rupees(i.unitPricePaise)} · incl. {i.gstRate}% GST ({rupees(i.taxPaise)})</p>
                  </div>
                  <div className="text-right text-sm font-semibold">{rupees(i.lineTotalPaise)}</div>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <p className="text-xs font-semibold uppercase text-slate-600">Coupon code</p>
              {!couponApplied ? (
                <div className="mt-1 flex gap-2">
                  <input value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="e.g. WELCOME10"
                         className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
                  <button type="button" onClick={applyCoupon} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Apply</button>
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
                  <span className="font-semibold text-emerald-900">{couponApplied} applied {t.discountPaise > 0 && <>· − {rupees(t.discountPaise)}</>}</span>
                  <button type="button" onClick={removeCoupon} className="text-xs font-semibold text-emerald-800 hover:underline">Remove</button>
                </div>
              )}
              {t.couponError && <p className="mt-1 text-xs text-red-600">{t.couponError}</p>}
            </div>

            {data.config.loyalty.enabled && data.user.loyaltyPoints > 0 && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold uppercase text-amber-900">Loyalty redemption</p>
                <p className="mt-1 text-xs text-amber-800">
                  You have <strong>{data.user.loyaltyPoints}</strong> points · 1 point = {rupees(data.config.loyalty.redeemValuePaise)}.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input type="number" min={0} max={data.user.loyaltyPoints} value={redeem || ''}
                         onChange={(e) => setRedeem(Math.max(0, Math.min(data.user.loyaltyPoints, Number(e.target.value || 0))))}
                         placeholder="Points to use" className="w-32 rounded-md border border-amber-300 px-3 py-1.5 text-sm" />
                  <button type="button" onClick={() => setRedeem(data.user.loyaltyPoints)}
                          className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">
                    Use all
                  </button>
                  {redeem > 0 && (
                    <button type="button" onClick={() => setRedeem(0)} className="text-xs text-amber-800 hover:underline">Clear</button>
                  )}
                </div>
                {t.loyaltyDiscountPaise > 0 && <p className="mt-1 text-xs text-amber-900">Applying {t.loyaltyPointsUsed} pts · − {rupees(t.loyaltyDiscountPaise)}</p>}
                {t.loyaltyError && <p className="mt-1 text-xs text-red-600">{t.loyaltyError}</p>}
              </div>
            )}

            <div className="mt-4">
              <p className="text-xs font-semibold uppercase text-slate-600">Note (optional)</p>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                        placeholder="Anything we should know about delivery?"
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>

            {data.user.isB2B && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase text-slate-600">GSTIN for invoice</p>
                <input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="22AAAAA0000A1Z5"
                       className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase tracking-wider" />
              </div>
            )}
          </section>

          {/* 3. Payment */}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">3 · Payment</h2>
            <p className="mt-1 text-sm text-slate-600">
              Pay <strong>{rupees(t.totalPaise)}</strong> via UPI to <strong>{data.config.paymentDisplay}</strong>
              {data.config.paymentUpiId && <> (<code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{data.config.paymentUpiId}</code>)</>}
              , then enter the Transaction ID (UTR) and upload the receipt below.
            </p>

            <div className="mt-4 grid gap-6 sm:grid-cols-[220px_1fr]">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/payment/qr.svg" alt="UPI QR code" className="aspect-square w-full" />
                <p className="mt-1 text-center text-xs text-slate-500">Scan with any UPI app</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold uppercase text-slate-600">Payment method</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as 'UPI' | 'IMPS' | 'NEFT' | 'RTGS')}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="UPI">UPI (12-digit ref)</option>
                    <option value="IMPS">IMPS (12-digit ref)</option>
                    <option value="NEFT">NEFT (16-char UTR)</option>
                    <option value="RTGS">RTGS (16–22-char UTR)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase text-slate-600">Transaction ID (UTR)</label>
                  <input
                    value={utr} onChange={(e) => setUtr(e.target.value.toUpperCase())}
                    placeholder={
                      paymentMethod === 'UPI' || paymentMethod === 'IMPS' ? '12-digit reference (e.g. 425912345678)' :
                      paymentMethod === 'NEFT' ? '16-char UTR (e.g. SBIN0123456789012)' :
                      '16–22 char UTR (e.g. SBINR52022060812345)'
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tracking-wider"
                    maxLength={32}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    {paymentMethod === 'UPI'
                      ? 'After paying, your UPI app shows a 12-digit reference / UTR number.'
                      : paymentMethod === 'IMPS'
                      ? 'IMPS RRN is a 12-digit reference from your bank app.'
                      : `The ${paymentMethod} UTR is shown in your bank's confirmation message — starts with your IFSC.`}
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase text-slate-600">Payment receipt (screenshot or PDF)</label>
                  <div className="mt-1 flex items-center gap-3">
                    <input
                      id="receipt-input" type="file" accept="image/*,application/pdf"
                      onChange={(e) => {
                        const f = e.target.files?.[0]; if (f) void uploadReceipt(f);
                      }}
                      className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800"
                    />
                  </div>
                  {uploadBusy && <p className="mt-1 text-xs text-slate-500">Uploading…</p>}
                  {receiptUrl && <p className="mt-1 text-xs text-emerald-700">✓ Uploaded {receiptName}</p>}
                  {uploadErr && <p className="mt-1 text-xs text-red-600">{uploadErr}</p>}
                  <p className="mt-1 text-[11px] text-slate-500">Max {data.config.maxReceiptMb} MB · JPG / PNG / WEBP / PDF</p>
                </div>

                {submitErr && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{submitErr}</div>}

                <button
                  type="button" onClick={submit} disabled={!canSubmit}
                  className="block w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitBusy ? 'Placing order…' : `Submit order · ${rupees(t.totalPaise)}`}
                </button>
                <p className="text-center text-[11px] text-slate-500">
                  Your order moves to <em>Pending payment review</em>; once we confirm the payment we&apos;ll start fulfilment and email you.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT — Sticky totals */}
        <aside className="sticky top-24 h-fit rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Summary</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="font-semibold">{rupees(t.subtotalPaise)}</dd></div>
            {t.discountPaise > 0 && <div className="flex justify-between text-emerald-700"><dt>Coupon</dt><dd>− {rupees(t.discountPaise)}</dd></div>}
            {t.loyaltyDiscountPaise > 0 && <div className="flex justify-between text-amber-700"><dt>Loyalty ({t.loyaltyPointsUsed} pts)</dt><dd>− {rupees(t.loyaltyDiscountPaise)}</dd></div>}
            <div className="flex justify-between"><dt className="text-slate-600">Shipping</dt><dd className={t.shippingPaise === 0 ? 'font-semibold text-emerald-700' : 'font-semibold'}>{t.shippingPaise === 0 ? 'FREE' : rupees(t.shippingPaise)}</dd></div>
            <div className="flex justify-between text-xs text-slate-500"><dt>Includes GST</dt><dd>{rupees(t.taxPaise)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold"><dt>Total</dt><dd>{rupees(t.totalPaise)}</dd></div>
          </dl>
          <Link href="/cart" className="mt-4 block text-center text-xs text-slate-500 hover:underline">← Back to cart</Link>
        </aside>
      </div>
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-5xl px-4 py-16 text-center text-sm text-slate-500">Loading checkout…</main>}>
      <CheckoutPageInner />
    </Suspense>
  );
}
