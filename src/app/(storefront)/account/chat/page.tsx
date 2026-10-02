'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Msg { id: string; body: string; fromId: string; isOwn: boolean; createdAt: string }

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const lastIdRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const dialog = useDialog();
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    const poll = async () => {
      while (aliveRef.current) {
        const qs = lastIdRef.current ? `?since=${encodeURIComponent(lastIdRef.current)}&wait=20` : '?wait=0';
        const r = await api<{ messages: Msg[] }>(`/api/account/chat${qs}`);
        if (r.status === 401) { window.location.href = '/login?next=/account/chat'; return; }
        if (r.ok && r.data) {
          setConnected(true);
          if (r.data.messages.length > 0) {
            setMessages((prev) => [...prev, ...r.data!.messages]);
            lastIdRef.current = r.data.messages[r.data.messages.length - 1].id;
          }
        }
        // small breather so we don't tight-loop on errors
        await new Promise((res) => setTimeout(res, 200));
      }
    };
    void poll();
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    const r = await api('/api/account/chat', { method: 'POST', body: { body: body.trim() } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Message not sent', message: r.error ?? 'Please try again.' }); return; }
    setBody('');
    // The next poll will fetch our own message via since=...
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">Live chat</h1>
      <p className="text-sm text-slate-600">Chat with our team during business hours. Replies usually arrive within minutes.</p>
      <p className="mt-1 text-xs text-slate-500">{connected ? '● Connected' : 'Connecting…'}</p>

      <div className="mt-4 flex h-[60vh] flex-col rounded-xl border border-slate-200 bg-white">
        <ul className="flex-1 space-y-2 overflow-y-auto p-3">
          {messages.length === 0 && <li className="text-center text-sm text-slate-500">Say hello to start the conversation.</li>}
          {messages.map((m) => (
            <li key={m.id} className={`flex ${m.isOwn ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.isOwn ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-900'}`}>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className={`mt-1 text-[10px] ${m.isOwn ? 'text-brand-100' : 'text-slate-500'}`}>{new Date(m.createdAt).toLocaleTimeString('en-IN')}</p>
              </div>
            </li>
          ))}
          <div ref={endRef} />
        </ul>
        <div className="flex gap-2 border-t border-slate-200 p-3">
          <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
                 placeholder="Type a message…" className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button onClick={send} disabled={busy || !body.trim()}
                  className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Send</button>
        </div>
      </div>
    </>
  );
}
