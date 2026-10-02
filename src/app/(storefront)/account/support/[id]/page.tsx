'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Msg { id: string; body: string; isOwn: boolean; createdAt: string; imageUrls?: string[] }
interface T { id: string; subject: string; category: string; status: string; createdAt: string; updatedAt: string; messages: Msg[] }

export default function TicketDetail() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const [t, setT] = useState<T | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ ticket: T }>(`/api/account/tickets/${id}`);
    if (r.status === 401) { window.location.href = `/login?next=/account/support/${id}`; return; }
    if (!r.ok) return;
    setT(r.data?.ticket ?? null);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    const r = await api(`/api/account/tickets/${id}/messages`, { method: 'POST', body: { body: body.trim() } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Message not sent', message: r.error ?? 'Please try again.' }); return; }
    setBody(''); await load();
  }

  if (!t) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">{t.subject}</h1>
      <p className="text-sm text-slate-600">{t.category} · {t.status.replace(/_/g, ' ')}</p>

      <ul className="mt-4 space-y-2">
        {t.messages.map((m) => (
          <li key={m.id} className={`flex ${m.isOwn ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.isOwn ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'}`}>
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className={`mt-1 text-[10px] ${m.isOwn ? 'text-brand-100' : 'text-slate-500'}`}>{new Date(m.createdAt).toLocaleString('en-IN')}</p>
            </div>
          </li>
        ))}
      </ul>

      {t.status !== 'CLOSED' && (
        <div className="mt-4 flex gap-2">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Reply…"
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button onClick={send} disabled={busy || !body.trim()}
                  className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Send</button>
        </div>
      )}
    </>
  );
}
