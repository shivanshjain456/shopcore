'use client';
/**
 * Forgot-password flow — Feature #12.
 *
 *   Step 1: Identify Account  ── /api/auth/forgot-password/initiate
 *   Step 2: Verify OTP        ── /api/auth/forgot-password/verify-otp
 *   Step 3: Reset Password    ── /api/auth/forgot-password/reset
 *   Step 4: Success           ── animated success state + redirect to /login
 *
 *   - Progress rail at the top (Identify → Verify → Reset)
 *   - 6-slot <OtpInput> with paste / arrow / backspace / autofill
 *   - Resend cooldown countdown (60s) with re-enabled "Resend Code" action
 *   - Reuses <PasswordField>, <PasswordStrengthMeter> from Feature #11
 *   - Subtle slide-in step transitions, prefers-reduced-motion respected
 *   - Polished animated success state (✓ scale-pop + fade-in)
 *   - Submission blocked when client validation fails; server is final authority
 *
 * The page is intentionally a single client component — the steps don't
 * have unique URLs (the resetToken would otherwise need to live in the URL).
 */
import {
  FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell, Field, Alert, SubmitButton } from '@/components/AuthForm';
import PasswordField from '@/components/auth/PasswordField';
import PasswordStrengthMeter from '@/components/auth/PasswordStrengthMeter';
import OtpInput from '@/components/auth/OtpInput';
import { api } from '@/lib/client/api';
import { validatePassword } from '@/lib/auth/passwordPolicy';

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: 'Identify Account',
  2: 'Verify OTP',
  3: 'Reset Password',
  4: 'Success',
};

const STEPS_FOR_RAIL: Array<{ n: 1 | 2 | 3; label: string }> = [
  { n: 1, label: 'Identify Account' },
  { n: 2, label: 'Verify OTP' },
  { n: 3, label: 'Reset Password' },
];

function StepRail({ current }: { current: Step }) {
  return (
    <ol
      aria-label="Forgot password steps"
      className="mb-6 flex items-center justify-between gap-2"
      data-testid="step-rail"
    >
      {STEPS_FOR_RAIL.map((s) => {
        const isDone = current > s.n || current === 4;
        const isCurrent = current === s.n;
        return (
          <li
            key={s.n}
            data-testid={`step-${s.n}`}
            aria-current={isCurrent ? 'step' : undefined}
            className="flex-1"
          >
            <div className="flex items-center gap-2">
              <span
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold',
                  'transition-colors duration-200 ease-out motion-reduce:transition-none',
                  isDone
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : isCurrent
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-300 bg-white text-slate-500',
                ].join(' ')}
              >
                {isDone ? '✓' : s.n}
              </span>
              <span
                className={[
                  'text-xs font-medium tracking-wide sm:text-sm',
                  isCurrent ? 'text-slate-900' : 'text-slate-500',
                ].join(' ')}
              >
                Step {s.n}: {s.label}
              </span>
            </div>
            <div
              className={[
                'mt-2 h-1 w-full rounded-full bg-slate-200 overflow-hidden',
              ].join(' ')}
              aria-hidden="true"
            >
              <div
                className={[
                  'h-full rounded-full bg-emerald-500',
                  'transition-transform duration-500 ease-out motion-reduce:transition-none',
                  'origin-left',
                ].join(' ')}
                style={{
                  transform: `scaleX(${isDone || isCurrent ? 1 : 0})`,
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepShell({ stepKey, children }: { stepKey: Step; children: React.ReactNode }) {
  // Subtle slide-in. Keyed by stepKey so transitioning between steps
  // re-mounts the inner block and replays the animation.
  return (
    <div
      key={stepKey}
      data-testid={`step-shell-${stepKey}`}
      className="animate-[fadeSlide_280ms_ease-out_both] motion-reduce:animate-none"
    >
      {children}
      <style jsx>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function ForgotInner() {
  const router = useRouter();
  const [step, setStep]   = useState<Step>(1);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo]   = useState<string | null>(null);

  // Step 1
  const [email, setEmail] = useState('');

  // Step 2 (and beyond — also displayed on step 3 as a reminder)
  const [requestId, setRequestId] = useState<string>('');
  const [requestExpiresAt, setRequestExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(60);

  // Step 3
  const [resetToken, setResetToken] = useState<string>('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pw2Touched, setPw2Touched] = useState(false);

  // Step 4 — success state, derived once
  const [successAt, setSuccessAt] = useState<Date | null>(null);

  // Resend countdown tick.
  useEffect(() => {
    if (step !== 2 || resendIn <= 0) return;
    const t = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [step, resendIn]);

  // Auto-redirect from success → /login after 3 seconds.
  const redirRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (step !== 4) return;
    redirRef.current = setTimeout(() => router.push('/login'), 3000);
    return () => {
      if (redirRef.current) clearTimeout(redirRef.current);
    };
  }, [step, router]);

  // Password validator (live).
  const pwResult = useMemo(() => validatePassword(pw, { email }), [pw, email]);
  const pwMatches = pw.length > 0 && pw === pw2;

  // ── handlers ──────────────────────────────────────────────────────────────
  const onInitiate = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    const r = await api<{ requestId: string; expiresAt: string; message: string }>(
      '/api/auth/forgot-password/initiate',
      { method: 'POST', body: { email: email.trim().toLowerCase() } },
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not start password reset. Please try again.');
      return;
    }
    setRequestId(r.data.requestId);
    setRequestExpiresAt(r.data.expiresAt);
    setInfo(r.data.message);
    setResendIn(60);
    setCode('');
    setStep(2);
  }, [email]);

  const onVerify = useCallback(async (codeArg?: string) => {
    const c = (codeArg ?? code).trim();
    if (c.length !== 6) {
      setError('Enter the 6-digit code we sent to your email.');
      return;
    }
    setError(null); setInfo(null); setBusy(true);
    const r = await api<{ resetToken: string; expiresAt: string }>(
      '/api/auth/forgot-password/verify-otp',
      { method: 'POST', body: { requestId, code: c } },
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Invalid code. Please try again.');
      return;
    }
    setResetToken(r.data.resetToken);
    setInfo(null);
    setStep(3);
  }, [code, requestId]);

  const onResend = useCallback(async () => {
    setError(null); setInfo(null);
    const r = await api<{ message: string; expiresAt: string }>(
      '/api/auth/forgot-password/resend',
      { method: 'POST', body: { requestId } },
    );
    if (!r.ok) {
      const wait = (r.raw?.retryAfterSeconds as number | undefined) ?? 60;
      setResendIn(wait);
      setError(r.error ?? 'Could not resend. Please wait and try again.');
      return;
    }
    setInfo('A new code has been sent to your email.');
    setCode('');
    setResendIn(60);
  }, [requestId]);

  const onReset = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null); setBusy(true);
    if (!pwResult.ok) {
      setBusy(false);
      setError(pwResult.reason ?? 'Password does not meet the policy.');
      return;
    }
    if (!pwMatches) {
      setBusy(false);
      setError('Passwords do not match.');
      return;
    }
    const r = await api<{ message: string }>(
      '/api/auth/forgot-password/reset',
      { method: 'POST', body: { resetToken, newPassword: pw, confirmPassword: pw2 } },
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Could not reset password. Please start over.');
      return;
    }
    // Clear sensitive memory.
    setResetToken('');
    setPw(''); setPw2('');
    setSuccessAt(new Date());
    setStep(4);
  }, [pw, pw2, pwResult, pwMatches, resetToken]);

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <AuthShell
      title={
        step === 4 ? 'Password Updated' :
        step === 1 ? 'Forgot your password?' :
        step === 2 ? 'Check your email' :
                     'Choose a new password'
      }
      subtitle={
        step === 4 ? `You can now sign in with your new password.` :
        step === 1 ? `Enter the email associated with your account and we'll send a verification code.` :
        step === 2 ? `We sent a 6-digit code to ${email}. It expires in 10 minutes.` :
                     `Use a strong password you have not used before.`
      }
      footer={
        step === 4 ? (
          <a className="font-semibold text-brand-600 hover:underline" href="/login">Continue to sign in →</a>
        ) : (
          <>Remembered it? <a className="font-semibold text-brand-600 hover:underline" href="/login">Sign in</a></>
        )
      }
    >
      {step !== 4 && <StepRail current={step} />}
      {error && <Alert kind="error">{error}</Alert>}
      {info  && <Alert kind="info">{info}</Alert>}

      {/* STEP 1 — IDENTIFY */}
      {step === 1 && (
        <StepShell stepKey={1}>
          <form onSubmit={onInitiate} className="space-y-4" noValidate data-testid="step1-form">
            <Field label="Email" name="email">
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="fp-email"
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </Field>
            <SubmitButton busy={busy} disabled={!email.trim()}>
              Send verification code
            </SubmitButton>
          </form>
        </StepShell>
      )}

      {/* STEP 2 — VERIFY OTP */}
      {step === 2 && (
        <StepShell stepKey={2}>
          <form
            onSubmit={(e) => { e.preventDefault(); onVerify(); }}
            className="space-y-5"
            noValidate
            data-testid="step2-form"
          >
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={(full) => { void onVerify(full); }}
              error={!!error}
              disabled={busy}
            />
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => { setStep(1); setError(null); setInfo(null); }}
                className="text-slate-500 hover:underline"
                data-testid="fp-back"
              >
                ← Use a different email
              </button>
              <button
                type="button"
                onClick={onResend}
                disabled={resendIn > 0}
                aria-disabled={resendIn > 0}
                data-testid="fp-resend"
                className="font-semibold text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
              >
                {resendIn > 0
                  ? `Resend OTP in ${String(Math.floor(resendIn / 60)).padStart(2, '0')}:${String(resendIn % 60).padStart(2, '0')}`
                  : 'Resend code'}
              </button>
            </div>
            <SubmitButton busy={busy} disabled={code.length !== 6}>
              Verify code
            </SubmitButton>
            {requestExpiresAt && (
              <p className="text-center text-xs text-slate-500">
                This reset session expires at{' '}
                {new Date(requestExpiresAt).toLocaleTimeString()}.
              </p>
            )}
          </form>
        </StepShell>
      )}

      {/* STEP 3 — RESET PASSWORD */}
      {step === 3 && (
        <StepShell stepKey={3}>
          <form onSubmit={onReset} className="space-y-4" noValidate data-testid="step3-form">
            <Field label="New password" name="newPassword">
              <PasswordField
                name="newPassword"
                autoComplete="new-password"
                value={pw}
                onChange={(v) => setPw(v)}
                data-testid="fp-pw"
              />
            </Field>
            <PasswordStrengthMeter password={pw} email={email} />
            <Field label="Confirm new password" name="confirmPassword">
              <PasswordField
                name="confirmPassword"
                autoComplete="new-password"
                value={pw2}
                onChange={(v) => setPw2(v)}
                onBlur={() => setPw2Touched(true)}
                data-testid="fp-pw2"
              />
            </Field>
            {pw2.length > 0 && pw2Touched && (
              <p
                className={[
                  'text-sm flex items-center gap-1',
                  pwMatches ? 'text-emerald-700' : 'text-red-700',
                ].join(' ')}
                role="status"
                aria-live="polite"
                data-testid="fp-match"
              >
                <span aria-hidden="true">{pwMatches ? '✓' : '✗'}</span>
                {pwMatches ? 'Passwords match' : 'Passwords do not match'}
              </p>
            )}
            <SubmitButton
              busy={busy}
              disabled={!pwResult.ok || !pwMatches}
            >
              Update password
            </SubmitButton>
          </form>
        </StepShell>
      )}

      {/* STEP 4 — SUCCESS */}
      {step === 4 && (
        <StepShell stepKey={4}>
          <div
            className="flex flex-col items-center gap-4 py-6"
            role="status"
            aria-live="polite"
            data-testid="fp-success"
          >
            <div
              className={[
                'flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl text-emerald-700',
                'animate-[popIn_420ms_cubic-bezier(.2,.9,.2,1.4)_both] motion-reduce:animate-none',
              ].join(' ')}
              aria-hidden="true"
            >
              ✓
            </div>
            <h2 className="text-xl font-bold text-slate-900">Password Updated</h2>
            <p className="text-center text-sm text-slate-600">
              Your password has been changed and all other devices have been signed out.
              <br />
              Redirecting to sign-in…
            </p>
            <a
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
              href="/login"
            >
              Continue to sign in
            </a>
            <p className="sr-only" aria-live="polite">
              {`Password updated successfully at ${successAt?.toLocaleTimeString() ?? 'now'}. Redirecting to the sign-in page.`}
            </p>
            <style jsx>{`
              @keyframes popIn {
                0%   { transform: scale(0.4); opacity: 0; }
                70%  { transform: scale(1.08); opacity: 1; }
                100% { transform: scale(1); }
              }
            `}</style>
          </div>
        </StepShell>
      )}
    </AuthShell>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading…</div>}>
      <ForgotInner />
    </Suspense>
  );
}
