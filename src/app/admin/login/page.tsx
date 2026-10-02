'use client';
/**
 * Admin login.
 *
 * Intentionally unlinked from public navigation. The URL itself is the only
 * "discovery" surface; the real protection is server-side (role=ADMIN check
 * + dedicated sc_admin cookie + tighter rate limit + audit log).
 */
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell, Field, Alert, SubmitButton } from '@/components/AuthForm';
import { api } from '@/lib/client/api';

export default function AdminLoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? '');
    const password = String(f.get('password') ?? '');
    const r = await api<{ email: string; purpose: 'LOGIN' }>('/api/auth/admin/login', {
      method: 'POST', body: { email, password },
    });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Login failed.'); return; }
    const qs = new URLSearchParams({ email, purpose: 'LOGIN', admin: '1' });
    router.push(`/verify?${qs.toString()}`);
  }

  return (
    <AuthShell
      title="Admin sign-in"
      subtitle="Restricted area. All actions are audited."
    >
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Admin email" name="email" type="email" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <SubmitButton busy={busy}>Continue</SubmitButton>
      </form>
    </AuthShell>
  );
}
