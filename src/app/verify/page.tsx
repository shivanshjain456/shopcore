'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell, Alert, SubmitButton, Field } from '@/components/AuthForm';
import { api } from '@/lib/client/api';

type Purpose = 'SIGNUP' | 'LOGIN' | 'RESET' | 'EMAIL_CHANGE';

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const purpose = (params.get('purpose') as Purpose) ?? 'SIGNUP';
  const isAdmin = params.get('admin') === '1';

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    const r = await api<{
      next: string;
      nextStep?: 'PHONE_VERIFICATION';
      redirectTo?: string;
    }>('/api/auth/otp/verify', {
      method: 'POST', body: { email, code, purpose },
    });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Invalid OTP.'); return; }

    // Merge guest cart (best effort) — runs regardless of nextStep so
    // the cart survives the extra phone-verification hop.
    try {
      const guest = JSON.parse(localStorage.getItem('sc_guest_cart_v1') || '[]');
      if (Array.isArray(guest) && guest.length > 0) {
        await api('/api/cart/merge', { method: 'POST', body: { items: guest } });
        localStorage.removeItem('sc_guest_cart_v1');
      }
    } catch { /* ignore */ }

    // Phone Verification feature — when the server signals the new
    // two-step flow, honour the redirect it dictates (never trust the
    // `next` query param to skip it).
    if (r.data?.nextStep === 'PHONE_VERIFICATION' && r.data?.redirectTo) {
      router.push(r.data.redirectTo);
      return;
    }

    const nextParam = new URLSearchParams(window.location.search).get('next');
    const next = nextParam || (r.data?.next) || (isAdmin ? '/admin' : '/account');
    router.push(next);
  }

  async function onResend() {
    setError(null); setInfo(null);
    const r = await api<{ expiresAt: string }>('/api/auth/otp/resend', {
      method: 'POST', body: { email, purpose },
    });
    if (!r.ok) {
      const wait = (r.raw?.retryAfterSeconds as number | undefined) ?? 60;
      setResendIn(wait);
      setError(r.error ?? 'Could not resend.');
      return;
    }
    setInfo('A new code has been sent to your email.');
    setResendIn(60);
  }

  if (!email) {
    return (
      <AuthShell title="Verification">
        <Alert kind="error">Missing email. Please <a className="underline" href="/login">sign in</a> again.</Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Enter the code we emailed you"
      subtitle={`We sent a 6-digit code to ${email}. It expires in 10 minutes.`}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {info && <Alert kind="success">{info}</Alert>}
      <form onSubmit={onVerify} className="space-y-4">
        <Field label="6-digit code" name="code">
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            pattern="\d*"
            required
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-center font-mono text-2xl tracking-[0.6em] shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        <SubmitButton busy={busy}>Verify and continue</SubmitButton>
      </form>
      <div className="mt-4 flex items-center justify-between text-sm">
        <a href={isAdmin ? '/admin/login' : '/login'} className="text-slate-500 hover:underline">← Back</a>
        <button
          type="button"
          onClick={onResend}
          disabled={resendIn > 0}
          className="font-semibold text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
        </button>
      </div>
    </AuthShell>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading…</div>}>
      <VerifyInner />
    </Suspense>
  );
}
