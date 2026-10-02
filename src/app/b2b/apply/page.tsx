'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';

interface Profile {
  role: string; status: 'NONE' | 'PENDING' | 'APPROVED';
  companyName: string | null; gstin: string | null; pan: string | null;
  approvedAt: string | null;
  tier: { name: string; discountPercent: number } | null;
}

export default function B2BApplyPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await api<{ profile: Profile }>('/api/b2b/me');
      if (r.status === 401) { window.location.href = '/login?next=/b2b/apply'; return; }
      setProfile(r.data?.profile ?? null);
    })();
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const r = await api<{ status: 'PENDING' | 'AUTO_APPROVED' }>('/api/b2b/apply', {
      method: 'POST',
      body: {
        companyName: String(f.get('companyName') ?? ''),
        gstin:       String(f.get('gstin') ?? '').toUpperCase(),
        pan:         String(f.get('pan') ?? '').toUpperCase(),
      },
    });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.error ?? 'Could not submit.' }); return; }
    if (r.data?.status === 'AUTO_APPROVED') {
      router.push('/b2b/dashboard');
      return;
    }
    setMsg({ kind: 'ok', text: 'Application submitted. We will email you when approved.' });
    // refresh
    const p = await api<{ profile: Profile }>('/api/b2b/me');
    setProfile(p.data?.profile ?? null);
  }

  if (!profile) return <main className="mx-auto max-w-3xl p-10 text-center text-sm text-slate-500">Loading…</main>;

  if (profile.status === 'APPROVED') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800">B2B approved</p>
          <h1 className="mt-1 text-2xl font-bold text-emerald-900">{profile.companyName}</h1>
          <p className="mt-1 text-sm text-emerald-800">Tier: <strong>{profile.tier?.name ?? '—'}</strong> ({profile.tier?.discountPercent ?? 0}% off)</p>
          <a href="/b2b/dashboard" className="mt-4 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
            Go to B2B dashboard →
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-wider text-brand-700">B2B portal</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Apply for a business account</h1>
        <p className="mt-1 text-sm text-slate-600">
          Get bulk pricing across the catalogue, GST invoices, and access to the quote-request flow.
        </p>

        {profile.status === 'PENDING' && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            ⏳ Your application is pending review. We will email you when approved.
          </div>
        )}

        {msg && (
          <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${msg.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}>
            {msg.text}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-semibold uppercase text-slate-600">Company / business name</span>
            <input name="companyName" required defaultValue={profile.companyName ?? ''}
                   className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">GSTIN (15 chars)</span>
              <input name="gstin" required minLength={15} maxLength={15} placeholder="22AAAAA0000A1Z5"
                     defaultValue={profile.gstin ?? ''}
                     className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase tracking-wider" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">PAN (10 chars)</span>
              <input name="pan" required minLength={10} maxLength={10} placeholder="AAAAA0000A"
                     defaultValue={profile.pan ?? ''}
                     className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase tracking-wider" />
            </label>
          </div>
          <button disabled={busy} type="submit" className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? 'Submitting…' : profile.status === 'PENDING' ? 'Re-submit application' : 'Submit application'}
          </button>
          <p className="text-[11px] text-slate-500">
            By submitting, you confirm the GSTIN and PAN belong to your business. We verify GSTIN format and checksum before saving.
          </p>
        </form>
      </div>
    </main>
  );
}
