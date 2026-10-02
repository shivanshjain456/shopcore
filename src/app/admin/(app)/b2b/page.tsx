'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import { formatPhone } from '@/lib/utils/phone';

interface Pending { id: string; firstName: string; lastName: string; email: string; phone: string; companyName: string; gstin: string; pan: string; createdAt: string }
interface Approved { id: string; email: string; companyName: string; gstin: string; tier: { id: string; name: string; discountPercent: number } | null; approvedAt: string }
interface Tier { id: string; name: string; discountPercent: number }

export default function B2BAdmin() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [approved, setApproved] = useState<Approved[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const a = await api<{ pending: Pending[]; approved: Approved[] }>('/api/admin/b2b-applications');
    if (a.ok && a.data) { setPending(a.data.pending); setApproved(a.data.approved); }
  };
  useEffect(() => {
    void load();
    fetch('/api/admin/tiers').then((r) => r.ok ? r.json() : { data: { items: [] } }).then((j) => setTiers(j?.data?.items ?? []));
  }, []);

  async function approve(id: string, tierId: string) {
    const r = await api(`/api/admin/b2b-applications/${id}/approve`, { method: 'POST', body: { tierId } });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; } setMsg('Approved.'); await load();
  }
  async function reject(id: string) {
    const reason = await dialog.promptUser({
      title: 'Reject B2B application',
      message: 'Optional — tell the applicant why so they can re-apply.',
      placeholder: 'e.g. GSTIN verification failed', multiline: true, maxLength: 500,
      confirmLabel: 'Reject', cancelLabel: 'Keep',
      intent: 'destructive',
    });
    if (reason === null) return;
    const r = await api(`/api/admin/b2b-applications/${id}/reject`, { method: 'POST', body: { reason } });
    if (!r.ok) { setMsg(r.error ?? 'Failed.'); return; } setMsg('Rejected.'); await load();
  }

  return (
    <>
      <PageHeader title="B2B applications" subtitle="Approve or reject business account requests." />
      {msg && <p className="mb-3 rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{msg}</p>}

      <Card>
        <h2 className="text-sm font-bold uppercase text-slate-700">Pending ({pending.length})</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {pending.length === 0 && <li className="py-4 text-sm text-slate-500">No pending applications.</li>}
          {pending.map((p) => (
            <li key={p.id} className="grid gap-2 py-3 md:grid-cols-[1fr_auto]">
              <div>
                <p className="font-semibold">{p.companyName}</p>
                <p className="text-xs">{p.firstName} {p.lastName} · {p.email} · {formatPhone(p.phone)}</p>
                <p className="text-xs">GSTIN <code className="font-mono">{p.gstin}</code> · PAN <code className="font-mono">{p.pan}</code></p>
                <p className="text-[11px] text-slate-500">Applied {new Date(p.createdAt).toLocaleString('en-IN')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select id={`tier-${p.id}`} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">
                  {tiers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.discountPercent}%)</option>)}
                </select>
                <Button tone="primary" onClick={() => approve(p.id, (document.getElementById(`tier-${p.id}`) as HTMLSelectElement).value)}>Approve</Button>
                <Button tone="danger" onClick={() => reject(p.id)}>Reject</Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-3">
        <h2 className="text-sm font-bold uppercase text-slate-700">Recent approvals</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {approved.length === 0 && <li className="py-3 text-sm text-slate-500">None yet.</li>}
          {approved.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2 text-sm">
              <span><strong>{u.companyName}</strong> <span className="text-slate-500">{u.email}</span></span>
              {u.tier && <StatusBadge s={u.tier.name} />}
              <span className="text-xs text-slate-500">{u.approvedAt ? new Date(u.approvedAt).toLocaleDateString('en-IN') : ''}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
