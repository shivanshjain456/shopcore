'use client';
/**
 * NewsletterForm — Item 18 Phase 2 client island.
 *
 *   Inline email-capture form for the storefront <NewsletterBlock>.
 *   POSTs to /api/newsletter/subscribe (uniform success — never leaks
 *   account existence). Shows an inline success / error message that
 *   is screen-reader-announced via aria-live.
 *
 *   We use the typed `api()` client wrapper so CSRF acquisition + JSON
 *   stringification are handled centrally.
 */
import React from 'react';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/client/api';

interface NewsletterFormProps {
  ctaLabel: string;
  /** Optional honeypot field name (defaults to `website`). Bots fill
   *  every input; humans never see this. */
  honeypotName?: string;
}

type FormState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string }
  | { kind: 'err'; message: string };

export default function NewsletterForm({ ctaLabel, honeypotName = 'website' }: NewsletterFormProps) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === 'busy') return;
    setState({ kind: 'busy' });
    const form = e.currentTarget;
    const fd = new FormData(form);
    const honey = String(fd.get(honeypotName) ?? '');
    const r = await api<{ received: true }>('/api/newsletter/subscribe', {
      method: 'POST',
      // `api()` JSON-stringifies the body for us — pass the raw object.
      body: { email, website: honey },
    });
    if (r.ok) {
      setState({ kind: 'ok', message: 'Thanks — we\u2019ll keep you posted.' });
      setEmail('');
      form.reset();
      return;
    }
    if (r.status === 429) {
      setState({ kind: 'err', message: 'Too many requests. Please try again later.' });
      return;
    }
    setState({
      kind: 'err',
      message: r.error ?? 'Could not subscribe right now. Please try again.',
    });
  }

  const busy = state.kind === 'busy';
  return (
    <form
      onSubmit={onSubmit}
      className="mt-5 flex w-full max-w-md flex-col gap-2 sm:flex-row"
      aria-describedby="newsletter-form-status"
      noValidate
    >
      <label className="sr-only" htmlFor="newsletter-email">Email address</label>
      <input
        id="newsletter-email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        maxLength={254}
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
        disabled={busy}
        className="tap-target flex-1 rounded-md border border-white/30 bg-white/95 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-60"
      />
      {/* Honeypot — hidden from sighted users + assistive tech. Bots fill it. */}
      <input
        type="text"
        name={honeypotName}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />
      <button
        type="submit"
        disabled={busy}
        className="tap-target inline-flex items-center justify-center rounded-md bg-white px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60"
      >
        {busy ? 'Subscribing\u2026' : ctaLabel}
      </button>
      <p
        id="newsletter-form-status"
        role="status"
        aria-live="polite"
        className={`min-h-[1.25rem] basis-full text-xs ${state.kind === 'err' ? 'text-red-200' : 'text-white/90'}`}
      >
        {state.kind === 'ok' || state.kind === 'err' ? state.message : ''}
      </p>
    </form>
  );
}
