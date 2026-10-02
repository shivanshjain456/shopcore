'use client';
/**
 * ContactForm — Item 13.
 *
 * Public + authenticated contact form on /contact. Submits to
 * `POST /api/contact`. Behaviours:
 *
 *   - Authenticated user: email rendered as read-only text (NOT an
 *     editable input). The server pins the email to the session
 *     anyway, but the UI matches the contract so the user isn't
 *     surprised by the value that arrives at the admin.
 *
 *   - Honeypot field `website` — present in the DOM with
 *     `tabIndex={-1}`, `aria-hidden`, `autoComplete="off"`, off-screen
 *     positioning. Bots fill it; humans never see it. The server
 *     silently 200s on hit.
 *
 *   - Character counter under the textarea, `aria-live="polite"`.
 *     Amber colour when >= 90 % of limit.
 *
 *   - Success state replaces the form (no redirect). Spec: "Thank
 *     you! …". When the API returns a `ticketId`, we surface it.
 *
 *   - Error state: <Alert> above the form. Per-field errors from
 *     VALIDATION_ERROR responses are NOT inlined per-field today —
 *     the message is shown in the alert.
 */
import { useCallback, useId, useState, type FormEvent } from 'react';
import { api } from '@/lib/client/api';
import { Alert, SubmitButton } from '@/components/AuthForm';
import {
  CONTACT_SUBJECT_MAX,
  CONTACT_MESSAGE_MIN,
  CONTACT_MESSAGE_MAX,
} from '@/lib/contact/schema';

export interface ContactFormProps {
  /** Pre-fill the name field for authenticated users. */
  defaultName?:    string;
  /** Pre-fill (and pin) the email for authenticated users. */
  defaultEmail?:   string;
  /** When true: email is read-only text, the value submitted is ignored
   *  by the server (which uses session.email). */
  isAuthenticated: boolean;
}

interface ApiSuccess { received: true; ticketId?: string | null }

export default function ContactForm({
  defaultName  = '',
  defaultEmail = '',
  isAuthenticated,
}: ContactFormProps): JSX.Element {
  const formId       = useId();
  const messageId    = `${formId}-message`;
  const countId      = `${formId}-count`;

  const [name,    setName]    = useState(defaultName);
  const [email,   setEmail]   = useState(defaultEmail);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [done,    setDone]    = useState<{ ticketId: string | null } | null>(null);

  const onSubmit = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<ApiSuccess>('/api/contact', {
        method: 'POST',
        body: {
          name:    name.trim(),
          // Authenticated path: server pins to session.email anyway,
          // but send the displayed value for consistency.
          email:   isAuthenticated ? defaultEmail : email.trim(),
          subject: subject.trim(),
          message: message.trim(),
          // Honeypot — bots fill every input. Real users get
          // `website: ''` because the field is off-screen.
          website: (
            (document.getElementById(`${formId}-website`) as HTMLInputElement | null)
              ?.value ?? ''
          ),
        },
      });
      if (!r.ok) {
        setError(r.error ?? 'Something went wrong. Please try again.');
        return;
      }
      setDone({ ticketId: r.data?.ticketId ?? null });
    } finally {
      setBusy(false);
    }
  }, [name, email, subject, message, defaultEmail, isAuthenticated, formId]);

  // ── Success state ── replace the form (spec: no redirect)
  if (done) {
    return (
      <div
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-900"
        role="status"
        aria-live="polite"
      >
        <h2 className="text-lg font-bold">Thank you!</h2>
        <p className="mt-2 text-sm">
          We&apos;ve received your message and will respond within 1–2 business days.
        </p>
        {done.ticketId && (
          <p className="mt-2 text-xs">
            Your tracking ID is{' '}
            <code className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono">
              {done.ticketId.slice(0, 12)}
            </code>
            . You can view this ticket from your account dashboard.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setSubject(''); setMessage('');
          }}
          className="tap-target mt-4 text-xs font-semibold text-emerald-800 underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  const count    = message.length;
  const overWarn = count >= Math.floor(CONTACT_MESSAGE_MAX * 0.9);   // 1800
  const countCls = overWarn ? 'text-amber-700' : 'text-slate-500';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-busy={busy}>
      {error && <Alert kind="error">{error}</Alert>}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Your name <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        <input
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>

      {/* Email — read-only for authenticated users (spec §3.3). */}
      <div>
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Email <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        {isAuthenticated ? (
          <p
            className="block w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
            aria-label={`Email (signed in as ${defaultEmail})`}
          >
            {defaultEmail}
          </p>
        ) : (
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}
        {isAuthenticated && (
          <p className="mt-1 text-xs text-slate-500">
            You&apos;re signed in — replies go to your account email.
          </p>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Subject <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        <input
          name="subject"
          type="text"
          required
          maxLength={CONTACT_SUBJECT_MAX}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={busy}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>

      <label className="block" htmlFor={messageId}>
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Message <span className="text-red-500" aria-hidden="true">*</span>
        </span>
        <textarea
          id={messageId}
          name="message"
          required
          rows={6}
          minLength={CONTACT_MESSAGE_MIN}
          maxLength={CONTACT_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={busy}
          aria-describedby={countId}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1 flex items-center justify-between text-xs">
          <span className="text-slate-500">
            {`Minimum ${CONTACT_MESSAGE_MIN} characters.`}
          </span>
          <span id={countId} aria-live="polite" className={`font-mono ${countCls}`}>
            {count} / {CONTACT_MESSAGE_MAX}
          </span>
        </p>
      </label>

      {/* Honeypot — kept in the DOM, off-screen. Real users never see it;
          bots that fill every input get a silent 200 from the server.
          We use position+clip rather than display:none because some bots
          ignore display:none-rendered inputs. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
        }}
      >
        <label htmlFor={`${formId}-website`}>Website (leave blank)</label>
        <input
          id={`${formId}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      <SubmitButton busy={busy}>Send message</SubmitButton>
    </form>
  );
}
