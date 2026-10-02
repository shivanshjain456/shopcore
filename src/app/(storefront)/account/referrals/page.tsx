'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

interface Resp {
  referralCode: string; referralLink: string; referrerBonus: number; refereeBonus: number;
  referrals: { id: string; name: string; status: string; joinedAt: string }[];
  totalSignups: number; activeSignups: number;
}

export default function ReferralsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await api<Resp>('/api/account/referrals');
      if (r.status === 401) { window.location.href = '/login?next=/account/referrals'; return; }
      setData(r.data ?? null);
    })();
  }, []);

  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Referrals</h1>
      <p className="text-sm text-slate-600">Refer a friend — they get <strong>{data.refereeBonus}</strong> points, you get <strong>{data.referrerBonus}</strong> points after they verify their email.</p>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-600">Your referral link</p>
        <div className="mt-1 flex items-center gap-2">
          <input readOnly value={data.referralLink} className="flex-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm" />
          <button onClick={() => { navigator.clipboard.writeText(data.referralLink); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">{copied ? 'Copied!' : 'Copy'}</button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Your referral code: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{data.referralCode}</code></p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <p className="text-xs uppercase text-slate-500">Signups</p>
          <p className="mt-1 text-2xl font-extrabold">{data.totalSignups}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <p className="text-xs uppercase text-slate-500">Active</p>
          <p className="mt-1 text-2xl font-extrabold text-emerald-700">{data.activeSignups}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <p className="text-xs uppercase text-slate-500">Pending</p>
          <p className="mt-1 text-2xl font-extrabold text-amber-700">{data.totalSignups - data.activeSignups}</p>
        </div>
      </div>

      <h2 className="mt-6 text-sm font-bold uppercase text-slate-700">Friends you&apos;ve referred</h2>
      <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {data.referrals.length === 0 && <li className="p-4 text-sm text-slate-500">No referrals yet.</li>}
        {data.referrals.map((r) => (
          <li key={r.id} className="flex items-center justify-between p-3 text-sm">
            <div>
              <p className="font-semibold">{r.name}</p>
              <p className="text-xs text-slate-500">Joined {new Date(r.joinedAt).toLocaleDateString('en-IN')}</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
