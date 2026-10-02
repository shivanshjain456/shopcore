'use client';
/**
 * SupportTicketForm — Item 13.
 *
 * Inline "Open a new ticket" form used by /support. Submits to the
 * existing `POST /api/account/tickets` endpoint (Item 8 — gated by
 * features.supportTickets) so we don't duplicate ticket-create logic.
 *
 * The existing endpoint uses `body` (not `message`) as the message
 * field name and supports the categories
 * `ORDER | PAYMENT | RETURN | TECH | OTHER` — we honour that exact
 * contract.
 *
 * `onCreated` fires after a successful submit so the parent list can
 * re-render with the new ticket.
 */
import { useCallback, useId, useState, type FormEvent } from 'react';
import { api } from '@/lib/client/api';
import { Alert } from '@/components/AuthForm';

const CATEGORIES = [
  { value: 'ORDER',   label: 'Order' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'RETURN',  label: 'Return' },
  { value: 'TECH',    label: 'Technical issue' },
  { value: 'OTHER',   label: 'Something else' },
] as const;

type Category = (typeof CATEGORIES)[number]['value'];

export interface SupportTicketFormProps {
  onCreated?: (ticket: { id: string }) => void;
  /** Render the form expanded by default. Default false (collapsed
   *  behind an "Open a new ticket" button). */
  defaultOpen?: boolean;
}

export default function SupportTicketForm({
  onCreated,
  defaultOpen = false,
}: SupportTicketFormProps): JSX.Element {
  const formId = useId();
  const [open,     setOpen]     = useState(defaultOpen);
  const [subject,  setSubject]  = useState('');
  const [category, setCategory] = useState<Category>('OTHER');
  const [message,  setMessage]  = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [done,     setDone]     = useState<{ id: string } | null>(null);

  const reset = useCallback(() => {
    setSubject(''); setCategory('OTHER'); setMessage('');
    setError(null); setDone(null);
  }, []);

  const onSubmit = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await api<{ id: string }>('/api/account/tickets', {
        method: 'POST',
        body: {
          subject:  subject.trim(),
          category,
          // Existing endpoint expects `body`, not `message`.
          body:     message.trim(),
        },
      });
      if (!r.ok) {
        setError(r.error ?? 'Could not create your ticket. Please try again.');
        return;
      }
      const id = r.data?.id;
      if (id) {
        setDone({ id });
        onCreated?.({ id });
      }
    } finally {
      setBusy(false);
    }
  }, [subject, category, message, onCreated]);

  if (!open && !done) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Open a new ticket
      </button>
    );
  }

  if (done) {
    return (
      <div
        className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900"
        role="status" aria-live="polite"
      >
        <p className="text-sm font-semibold">Ticket created.</p>
        <p className="mt-1 text-xs">
          Tracking ID:{' '}
          <code className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono">
            {done.id.slice(0, 12)}
          </code>
        </p>
        <button
          type="button"
          onClick={() => { reset(); setOpen(false); }}
          className="tap-target mt-3 text-xs font-semibold text-emerald-800 underline"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      id={formId}
      onSubmit={onSubmit}
      noValidate
      aria-busy={busy}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      {error && <Alert kind="error">{error}</Alert>}
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
          Subject <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        <input
          type="text" required maxLength={160}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={busy}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
          Category
        </span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          disabled={busy}
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
          Message <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        <textarea
          required minLength={2} maxLength={4000} rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={busy}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="tap-target rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Create ticket'}
        </button>
        <button
          type="button"
          onClick={() => { reset(); setOpen(false); }}
          disabled={busy}
          className="tap-target rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
