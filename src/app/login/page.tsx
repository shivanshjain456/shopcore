'use client';

import { FormEvent, Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell, Field, Alert, SubmitButton } from '@/components/AuthForm';
import { api } from '@/lib/client/api';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '';
  // Feature #9 — when redirected here from a logout, show a friendly banner.
  const signedOutReason = params.get('signed_out');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? '');
    const password = String(f.get('password') ?? '');
    const r = await api<{ email: string; purpose: 'SIGNUP' | 'LOGIN' }>(
      '/api/auth/login', { method: 'POST', body: { email, password } });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Login failed.'); return; }
    const purpose = (r.data?.purpose) ?? 'LOGIN';
    const qs = new URLSearchParams({ email, purpose, ...(next ? { next } : {}) });
    router.push(`/verify?${qs.toString()}`);
  }

  return (
    <AuthShell
      title="Sign in to ShopCore"
      subtitle="Enter your email and password. We'll send a one-time code to your email next."
      footer={<>New here? <a className="font-semibold text-brand-600 hover:underline" href="/signup">Create an account</a></>}
    >
      {signedOutReason && (
        <div
          role="status"
          data-testid="signed-out-banner"
          className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          You&apos;re signed out. Sign in again to continue.
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <div className="flex justify-end -mt-2">
          <a
            href="/forgot-password"
            data-testid="login-forgot-link"
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            Forgot password?
          </a>
        </div>
        <SubmitButton busy={busy}>Continue</SubmitButton>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading…</div>}>
      <LoginInner />
    </Suspense>
  );
}
