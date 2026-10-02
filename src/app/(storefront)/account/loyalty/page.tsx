'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';

interface LoyaltyResp {
  balance: number;
  enabled: boolean;
  mode: 'DISABLED' | 'PER_AMOUNT' | 'PERCENT';
  description: string;
  pointsPerAmount: number;
  amountUnitPaise: number;
  percentBps: number;
  redeemValuePaise: number;
  signupBonus: number;
  ledger: { id: string; delta: number; reason: string; refId: string | null; createdAt: string }[];
}

export default function LoyaltyPage() {
  const [data, setData] = useState<LoyaltyResp | null>(null);
  useEffect(() => {
    (async () => {
      const r = await api<LoyaltyResp>('/api/account/loyalty');
      if (r.status === 401) { window.location.href = '/login?next=/account/loyalty'; return; }
      setData(r.data ?? null);
    })();
  }, []);

  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Loyalty &amp; rewards</h1>
      <p className="text-sm text-slate-600">{data.description} 1 point = {rupees(data.redeemValuePaise)}. Redeem at checkout.</p>

      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-xs font-semibold uppercase text-amber-900">Current balance</p>
        <p className="mt-1 text-3xl font-extrabold text-amber-900">{data.balance} <span className="text-base font-medium">points</span></p>
        <p className="text-xs text-amber-800">≈ {rupees(data.balance * data.redeemValuePaise)} value</p>
      </div>

      <h2 className="mt-6 text-sm font-bold uppercase text-slate-700">Activity</h2>
      <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {data.ledger.length === 0 && <li className="p-4 text-sm text-slate-500">No activity yet.</li>}
        {data.ledger.map((l) => (
          <li key={l.id} className="flex items-center justify-between p-3 text-sm">
            <div>
              <p className="font-semibold">{l.reason.replace(/_/g, ' ')}</p>
              <p className="text-xs text-slate-500">{new Date(l.createdAt).toLocaleString('en-IN')}</p>
            </div>
            <p className={`font-bold ${l.delta > 0 ? 'text-emerald-700' : l.delta < 0 ? 'text-red-700' : 'text-slate-500'}`}>
              {l.delta > 0 ? '+' : ''}{l.delta || '0'}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
