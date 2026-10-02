'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import { formatPhone } from '@/lib/utils/phone';

interface User {
  id: string; firstName: string; lastName: string; email: string; phone: string;
  role: string; status: string; loyaltyPoints: number; referralCode: string;
  companyName: string | null; gstin: string | null; pan: string | null;
  addressLine1: string; addressLine2: string; city: string; state: string; pinCode: string; country: string;
  createdAt: string; lastLoginAt: string | null;
  b2bTier: { id: string; name: string; discountPercent: number } | null;
  addresses: { id: string; label: string | null; city: string; state: string; pinCode: string; isDefault: boolean }[];
  orders: { id: string; orderNumber: string; status: string; totalPaise: number; createdAt: string }[];
  loyaltyLedger: { id: string; delta: number; reason: string; createdAt: string }[];
  _count: { orders: number; reviews: number; returns: number; tickets: number };
}

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const [u, setU] = useState<User | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ user: User }>(`/api/admin/customers/${id}`);
    if (r.ok && r.data) setU(r.data.user);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function suspend() {
    const ok = await dialog.confirm({
      title: 'Suspend this account?',
      message: 'They will be signed out from every device and unable to sign in until reactivated.',
      intent: 'destructive', confirmLabel: 'Suspend',
    });
    if (!ok) return;
    const r = await api(`/api/admin/customers/${id}`, { method: 'PATCH', body: { status: 'SUSPENDED' } });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg('Suspended.'); await load();
  }
  async function reactivate() {
    const r = await api(`/api/admin/customers/${id}`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg('Reactivated.'); await load();
  }
  async function adjustLoyalty() {
    const raw = await dialog.promptUser({
      title: 'Adjust loyalty points',
      message: 'Positive numbers credit; negative numbers debit. A 0-delta or blank entry cancels.',
      placeholder: 'e.g. 500  or  -200',
      inputType: 'number', required: true,
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 'Enter a finite number.';
        if (Math.floor(n) !== n) return 'Whole numbers only.';
        if (n === 0) return 'Enter a non-zero adjustment, or cancel.';
        if (Math.abs(n) > 1_000_000) return 'Out of range.';
        return null;
      },
      confirmLabel: 'Apply adjustment',
    });
    if (raw === null) return;
    const n = Number(raw);
    const r = await api(`/api/admin/customers/${id}`, { method: 'PATCH', body: { loyaltyAdjust: n, loyaltyAdjustReason: 'Manual' } });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; }
    setMsg(`Adjusted ${n} points.`); await load();
  }

  if (!u) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <PageHeader title={`${u.firstName} ${u.lastName}`} subtitle={`${u.email} · joined ${new Date(u.createdAt).toLocaleDateString('en-IN')}`}
        actions={<>
          <Button tone="ghost" onClick={adjustLoyalty}>Adjust loyalty</Button>
          {u.status === 'SUSPENDED' ? <Button onClick={reactivate}>Reactivate</Button>
            : u.role !== 'ADMIN' && <Button tone="danger" onClick={suspend}>Suspend</Button>}
        </>} />
      {msg && <p className="mb-3 rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{msg}</p>}

      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Profile</h2>
            <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-slate-500">Role / status</dt><dd className="flex gap-1"><StatusBadge s={u.role} /><StatusBadge s={u.status} /></dd>
              <dt className="text-slate-500">Phone</dt><dd>{formatPhone(u.phone)}</dd>
              <dt className="text-slate-500">Loyalty</dt><dd className="font-semibold">{u.loyaltyPoints} pts</dd>
              <dt className="text-slate-500">Referral code</dt><dd className="font-mono text-xs">{u.referralCode}</dd>
              {u.companyName && <><dt className="text-slate-500">Company</dt><dd>{u.companyName}</dd></>}
              {u.gstin && <><dt className="text-slate-500">GSTIN / PAN</dt><dd className="font-mono text-xs">{u.gstin} / {u.pan ?? '—'}</dd></>}
              {u.b2bTier && <><dt className="text-slate-500">B2B tier</dt><dd>{u.b2bTier.name} ({u.b2bTier.discountPercent}%)</dd></>}
              <dt className="text-slate-500">Primary address</dt><dd>{u.addressLine1}, {u.addressLine2}, {u.city}, {u.state} — {u.pinCode}</dd>
              <dt className="text-slate-500">Last login</dt><dd>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-IN') : '—'}</dd>
            </dl>
          </Card>

          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Recent orders ({u._count.orders})</h2>
            <ul className="mt-2 divide-y divide-slate-100">
              {u.orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-1.5 text-sm">
                  <Link href={`/admin/orders/${o.id}`} className="font-mono text-xs text-brand-700 hover:underline">{o.orderNumber}</Link>
                  <span><StatusBadge s={o.status} /></span>
                  <span className="font-semibold">{rupees(o.totalPaise)}</span>
                </li>
              ))}
              {u.orders.length === 0 && <li className="py-3 text-sm text-slate-500">No orders.</li>}
            </ul>
          </Card>

          <Card>
            <h2 className="text-sm font-bold uppercase text-slate-700">Loyalty ledger</h2>
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {u.loyaltyLedger.map((l) => (
                <li key={l.id} className="flex justify-between py-1">
                  <span>{l.reason.replace(/_/g, ' ')} <span className="text-xs text-slate-500">{new Date(l.createdAt).toLocaleString('en-IN')}</span></span>
                  <span className={`font-bold ${l.delta > 0 ? 'text-emerald-700' : l.delta < 0 ? 'text-red-700' : 'text-slate-500'}`}>{l.delta > 0 ? '+' : ''}{l.delta}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="h-fit space-y-3">
          <Card><h2 className="text-sm font-bold uppercase text-slate-700">Counters</h2><dl className="mt-2 grid grid-cols-2 gap-1 text-sm"><dt>Orders</dt><dd className="text-right font-semibold">{u._count.orders}</dd><dt>Reviews</dt><dd className="text-right font-semibold">{u._count.reviews}</dd><dt>Returns</dt><dd className="text-right font-semibold">{u._count.returns}</dd><dt>Tickets</dt><dd className="text-right font-semibold">{u._count.tickets}</dd></dl></Card>
          <Card><h2 className="text-sm font-bold uppercase text-slate-700">Addresses</h2><ul className="mt-2 space-y-1 text-xs">{u.addresses.map((a) => <li key={a.id}>{a.label ?? '-'} · {a.city}, {a.state} — {a.pinCode}{a.isDefault && ' (default)'}</li>)}</ul></Card>
        </aside>
      </div>
    </>
  );
}
