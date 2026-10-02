'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';

interface Room { id: string; status: string; updatedAt: string; messageCount: number; user: { id: string; email: string; firstName: string; lastName: string }; lastMessage: { body: string; createdAt: string; fromId: string } | null }
interface Msg { id: string; body: string; fromId: string; createdAt: string }

export default function AdminChat() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [active, setActive] = useState<Room | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const lastIdRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const dialog = useDialog();

  const loadRooms = async () => {
    const r = await api<{ rooms: Room[] }>('/api/admin/chat');
    if (r.ok && r.data) setRooms(r.data.rooms);
  };
  useEffect(() => { void loadRooms(); const i = setInterval(loadRooms, 10_000); return () => clearInterval(i); }, []);

  useEffect(() => {
    if (!active) return;
    aliveRef.current = true;
    lastIdRef.current = null;
    setMessages([]);
    const poll = async () => {
      while (aliveRef.current) {
        const qs = lastIdRef.current ? `?roomId=${active.id}&since=${lastIdRef.current}&wait=20` : `?roomId=${active.id}&wait=0`;
        const r = await api<{ messages: Msg[] }>(`/api/admin/chat${qs}`);
        if (r.ok && r.data?.messages.length) {
          setMessages((prev) => [...prev, ...r.data!.messages]);
          lastIdRef.current = r.data.messages[r.data.messages.length - 1].id;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
    };
    void poll();
    return () => { aliveRef.current = false; };
  }, [active]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send() {
    if (!active || !reply.trim()) return;
    setBusy(true);
    const r = await api('/api/admin/chat', { method: 'POST', body: { roomId: active.id, body: reply.trim() } });
    setBusy(false);
    if (!r.ok) { await dialog.alert({ title: 'Send failed', message: r.error ?? 'Please try again.' }); return; }
    setReply('');
  }

  return (
    <>
      <PageHeader title="Live chat" subtitle="One inbox for all customer conversations." />
      <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {rooms.map((r) => (
              <li key={r.id}>
                <button onClick={() => setActive(r)} className={`block w-full p-3 text-left hover:bg-slate-50 ${active?.id === r.id ? 'bg-amber-50' : ''}`}>
                  <p className="text-sm font-semibold">{r.user.firstName} {r.user.lastName}</p>
                  <p className="text-xs text-slate-500">{r.user.email}</p>
                  {r.lastMessage && <p className="mt-1 line-clamp-1 text-xs text-slate-600">{r.lastMessage.body}</p>}
                  <div className="mt-1 flex items-center justify-between text-[10px]"><StatusBadge s={r.status} /><span className="text-slate-400">{new Date(r.updatedAt).toLocaleString('en-IN')}</span></div>
                </button>
              </li>
            ))}
            {rooms.length === 0 && <li className="p-6 text-center text-sm text-slate-500">No chat rooms yet.</li>}
          </ul>
        </Card>

        <Card className="flex h-[60vh] flex-col">
          {!active ? (
            <p className="m-auto text-sm text-slate-500">Select a conversation.</p>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <p className="font-semibold">{active.user.firstName} {active.user.lastName} · <span className="text-xs text-slate-500">{active.user.email}</span></p>
                <StatusBadge s={active.status} />
              </div>
              <ul className="flex-1 space-y-2 overflow-y-auto py-3">
                {messages.map((m) => (
                  <li key={m.id} className={`flex ${m.fromId === active.user.id ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.fromId === active.user.id ? 'bg-slate-100' : 'bg-brand-600 text-white'}`}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className={`mt-1 text-[10px] ${m.fromId === active.user.id ? 'text-slate-500' : 'text-brand-100'}`}>{new Date(m.createdAt).toLocaleTimeString('en-IN')}</p>
                    </div>
                  </li>
                ))}
                <div ref={endRef} />
              </ul>
              <div className="flex gap-2 border-t border-slate-200 pt-2">
                <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} placeholder="Type a message…" className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
                <Button onClick={send} disabled={busy || !reply.trim()}>Send</Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
