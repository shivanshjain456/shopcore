'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Msg { id: string; body: string; authorId: string; createdAt: string }
interface T { id: string; subject: string; category: string; status: string; createdAt: string; user: { id: string; email: string; firstName: string; lastName: string }; messages: Msg[] }

export default function AdminTicketDetail() {
  const params = useParams<{ id: string }>(); const id = String(params.id);
  const [t, setT] = useState<T | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialog();

  const load = async () => { const r = await api<{ ticket: T }>(`/api/admin/tickets/${id}`); if (r.ok && r.data) setT(r.data.ticket); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function send() {
    if (!reply.trim()) return;
    setBusy(true);
    const r = await api(`/api/admin/tickets/${id}/messages`, { method: 'POST', body: { body: reply.trim() } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Reply failed', message: r.error ?? 'Please try again.' }); return; }
    setReply(''); await load();
  }
  async function setStatus(s: string) {
    await api(`/api/admin/tickets/${id}`, { method: 'PATCH', body: { status: s } }); await load();
  }
  if (!t) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <>
      <PageHeader title={t.subject} subtitle={`${t.category} · ${t.user.email}`}
        actions={<>
          <select value={t.status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
            {['OPEN','AWAITING_AGENT','AWAITING_CUSTOMER','RESOLVED','CLOSED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <StatusBadge s={t.status} />
        </>}
      />
      <Card>
        <ul className="space-y-2">
          {t.messages.map((m) => (
            <li key={m.id} className={`flex ${m.authorId === t.user.id ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.authorId === t.user.id ? 'bg-slate-100 text-slate-900' : 'bg-brand-600 text-white'}`}>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className={`mt-1 text-[10px] ${m.authorId === t.user.id ? 'text-slate-500' : 'text-brand-100'}`}>{new Date(m.createdAt).toLocaleString('en-IN')}</p>
              </div>
            </li>
          ))}
        </ul>
        {t.status !== 'CLOSED' && (
          <div className="mt-3 flex gap-2">
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Reply as admin…" className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <Button onClick={send} disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
          </div>
        )}
      </Card>
    </>
  );
}
