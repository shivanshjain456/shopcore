'use client';
/**
 * SupportTicketList — Item 13.
 *
 * Renders a server-fetched list of the user's recent tickets +
 * embeds <SupportTicketForm> for inline creation. On a successful
 * create we DON'T re-fetch from the server (would require an extra
 * round-trip); instead we prepend the new ticket optimistically to
 * the displayed list, and the next page navigation surfaces the
 * authoritative server view.
 */
import Link from 'next/link';
import { useState } from 'react';
import SupportTicketForm from './SupportTicketForm';

export interface TicketRow {
  id:        string;
  subject:   string;
  status:    string;
  updatedAt: string;
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const cls =
    /RESOLVED|CLOSED/i.test(status) ? 'bg-emerald-100 text-emerald-800'
  : /OPEN|AWAITING/i.test(status)   ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-700';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function fmt(ts: string): string {
  return new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SupportTicketList({
  initialTickets,
}: { initialTickets: readonly TicketRow[] }): JSX.Element {
  const [tickets, setTickets] = useState<TicketRow[]>(() => [...initialTickets]);

  return (
    <div className="space-y-4">
      {tickets.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
          No support tickets yet. We&apos;re here if you need us.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/account/support/${t.id}`}
                  className="tap-target flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{t.subject}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Updated {fmt(t.updatedAt)}</p>
                  </div>
                  <StatusPill status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SupportTicketForm
          onCreated={(t) => {
            // Optimistic prepend — the user sees their new ticket
            // immediately. The next navigation re-fetches the
            // authoritative list from the server.
            setTickets((prev) => [
              { id: t.id, subject: '(New ticket)', status: 'OPEN', updatedAt: new Date().toISOString() },
              ...prev,
            ]);
          }}
        />
        <Link
          href="/account/support"
          className="text-xs font-semibold text-brand-700 underline"
        >
          View all tickets →
        </Link>
      </div>
    </div>
  );
}
