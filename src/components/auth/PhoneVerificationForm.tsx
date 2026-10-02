'use client';
/**
 * <PhoneVerificationForm>
 *
 * Drives the client-side half of phone verification:
 *
 *   1. Init an invisible reCAPTCHA in a hidden <div>.
 *   2. "Send code" → call `signInWithPhoneNumber(auth, phone, verifier)`.
 *   3. User enters SMS code in <OtpInput>; we `confirm(code)`.
 *   4. Extract `idToken` from the resulting credential and POST to
 *      `/api/auth/phone/verify { idToken, phone }`.
 *   5. On HTTP 200 → call props.onSuccess(accountStatus).
 *
 * Dev-bypass: when `isFirebaseConfigured()` returns false, render a
 * plain OTP input that accepts `000000` and submits the literal
 * the DEV_BYPASS_TOKEN string to the server. The server rejects bypass
 * unconditionally in production — so this path is safe to leave in
 * the bundle.
 *
 * All Firebase error codes are mapped through a local table to friendly
 * UI strings — raw Firebase messages are never rendered.
 *
 * Accessibility: phone number is masked (last-4 only). All interactive
 * controls carry `.tap-target`. Reduced-motion users skip entry
 * animations. Error messages are linked via `aria-describedby`.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Alert } from '@/components/AuthForm';
import OtpInput from '@/components/auth/OtpInput';
import { api } from '@/lib/client/api';
import { getFirebaseAuth, isFirebaseConfigured } from '@/lib/client/firebase';
import { DEV_BYPASS_TOKEN } from '@/lib/auth/phoneConstants';

/** Map of Firebase Auth error codes → friendly UI strings.
 *
 *  Anything not listed falls through to a generic "could not verify"
 *  message. Raw Firebase codes are NEVER shown to the user. */
const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-verification-code': 'Incorrect OTP. Please try again.',
  'auth/code-expired':              'OTP expired. Please request a new one.',
  'auth/too-many-requests':         'Too many attempts. Please wait before trying again.',
  'auth/invalid-phone-number':      'This phone number is not valid.',
  'auth/network-request-failed':    'Network error. Check your connection and retry.',
  'auth/missing-verification-code': 'Please enter the 6-digit code we sent you.',
  'auth/quota-exceeded':            'SMS quota reached. Please try again later.',
  'auth/id-token-expired':          'Your session expired. Please request a new verification code.',
  'auth/captcha-check-failed':      'Security check failed. Please refresh and try again.',
};

function mapFirebaseError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code && FIREBASE_ERROR_MESSAGES[code]) return FIREBASE_ERROR_MESSAGES[code];
  return 'Could not verify your code. Please request a new one.';
}

interface Props {
  phone: string;
  onSuccess: (accountStatus: string) => void;
  resendCooldownSeconds?: number;
}

/** Mask a +91 number to its last 4 digits. `+919876543210` → `+91 ••••• ••3210` */
function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  const tail = phone.slice(-4);
  // Display variant: keep +91, separate into groups
  if (phone.startsWith('+91') && phone.length === 13) {
    return `+91 ••••• ••${tail}`;
  }
  return `${phone.slice(0, 3)}${'•'.repeat(Math.max(0, phone.length - 7))}${tail}`;
}

export default function PhoneVerificationForm({
  phone,
  onSuccess,
  resendCooldownSeconds = 60,
}: Props) {
  const [stage, setStage] = useState<'init' | 'awaiting-otp' | 'verifying' | 'success' | 'error'>('init');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo]   = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);

  // We deliberately type these as `unknown` boxes because the Firebase
  // types we'd reference are dynamic-imported — referencing them
  // statically would force the client SDK to be bundled even in dev-
  // bypass mode. The runtime values come straight from the SDK.
  const recaptchaContainerRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<{ clear: () => void } | null>(null);
  const confirmationRef = useRef<{ confirm: (code: string) => Promise<{ user: { getIdToken: () => Promise<string> } }> } | null>(null);

  const isBypass = !isFirebaseConfigured();

  // Resend countdown driver.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  // Tear down the recaptcha verifier on unmount.
  useEffect(() => {
    return () => {
      try { verifierRef.current?.clear(); } catch { /* ignore */ }
      verifierRef.current = null;
    };
  }, []);

  const sendCode = useCallback(async () => {
    setError(null); setInfo(null); setBusy(true);
    try {
      if (isBypass) {
        // Dev path — no Firebase, no SMS. Server still expects the
        // canonical bypass token.
        setStage('awaiting-otp');
        setInfo('Dev bypass — enter 000000 to verify.');
        setResendIn(resendCooldownSeconds);
        return;
      }
      const auth = await getFirebaseAuth();
      if (!auth) {
        setError('Phone verification is not available right now. Please try again later.');
        setStage('error');
        return;
      }

      // Lazy import keeps the Firebase JS SDK out of the dev-bypass bundle.
      const { RecaptchaVerifier, signInWithPhoneNumber } = await import('firebase/auth');

      if (!recaptchaContainerRef.current) {
        setError('Verification widget could not load. Please refresh the page.');
        setStage('error');
        return;
      }

      // Recreate the verifier each send — Firebase throws if a cleared
      // verifier is reused.
      try { verifierRef.current?.clear(); } catch { /* ignore */ }
      const verifier = new RecaptchaVerifier(auth, recaptchaContainerRef.current, { size: 'invisible' });
      verifierRef.current = verifier;

      const confirmation = await signInWithPhoneNumber(auth, phone, verifier);
      confirmationRef.current = confirmation as unknown as typeof confirmationRef.current;
      setStage('awaiting-otp');
      setInfo('We sent a 6-digit code to your phone.');
      setResendIn(resendCooldownSeconds);
    } catch (e) {
      setError(mapFirebaseError(e));
      setStage('error');
    } finally {
      setBusy(false);
    }
  }, [isBypass, phone, resendCooldownSeconds]);

  const submitOtp = useCallback(async (full: string) => {
    setError(null); setInfo(null); setBusy(true); setStage('verifying');
    try {
      let idToken: string;
      if (isBypass) {
        if (full !== '000000') {
          setError('Incorrect OTP. In dev-bypass mode, the only accepted code is 000000.');
          setStage('awaiting-otp'); return;
        }
        idToken = DEV_BYPASS_TOKEN;
      } else {
        if (!confirmationRef.current) {
          setError('Please request a new code.');
          setStage('init'); return;
        }
        const credential = await confirmationRef.current.confirm(full);
        idToken = await credential.user.getIdToken();
      }

      const r = await api<{ accountStatus: string; phoneVerified: true }>(
        '/api/auth/phone/verify',
        { method: 'POST', body: { idToken, phone } },
      );
      if (!r.ok) {
        setError(r.error ?? 'Verification failed.');
        setStage('awaiting-otp');
        return;
      }
      setStage('success');
      onSuccess(r.data?.accountStatus ?? 'ACTIVE');
    } catch (e) {
      setError(mapFirebaseError(e));
      setStage('awaiting-otp');
    } finally {
      setBusy(false);
    }
  }, [isBypass, onSuccess, phone]);

  const resendOtp = useCallback(async () => {
    if (resendIn > 0) return;
    setError(null); setInfo(null);
    // Hit the server gate FIRST (rate-limit + state-check) before
    // re-triggering Firebase. The server returns canProceed=true on success.
    const gate = await api<{ canProceed: boolean }>('/api/auth/phone/resend-otp', {
      method: 'POST', body: { phone },
    });
    if (!gate.ok) {
      const wait = (gate.raw?.retryAfterSeconds as number | undefined) ?? resendCooldownSeconds;
      setResendIn(wait);
      setError(gate.error ?? 'Please wait before resending.');
      return;
    }
    await sendCode();
  }, [phone, resendCooldownSeconds, resendIn, sendCode]);

  // Auto-submit when 6 digits entered.
  const handleCompleted = useCallback((full: string) => {
    setCode(full);
    void submitOtp(full);
  }, [submitOtp]);

  return (
    <div className="space-y-4" data-testid="phone-verification-form">
      {/* Always-mounted hidden reCAPTCHA host — Firebase needs the node
          in the DOM before RecaptchaVerifier is constructed. */}
      <div
        ref={recaptchaContainerRef}
        id="sc-recaptcha-container"
        aria-hidden="true"
        className="invisible h-0 w-0 overflow-hidden"
      />

      {isBypass && (
        <Alert kind="info">
          <strong>⚠ Firebase not configured</strong> — running in dev-bypass mode.
          Enter <code className="font-mono">000000</code> as the OTP.
        </Alert>
      )}

      <p className="text-sm text-slate-700">
        We&rsquo;ll send a 6-digit verification code to{' '}
        <span className="font-mono font-semibold">{maskPhone(phone)}</span>.
      </p>

      {error && (
        <Alert kind="error">
          <span id="phone-verify-error">{error}</span>
        </Alert>
      )}
      {info && !error && <Alert kind="info">{info}</Alert>}

      {stage === 'init' || stage === 'error' ? (
        <button
          type="button"
          onClick={() => { if (!busy) void sendCode(); }}
          disabled={busy}
          className="tap-target inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 sm:py-2.5"
        >
          {busy ? 'Sending…' : 'Send verification code'}
        </button>
      ) : null}

      {(stage === 'awaiting-otp' || stage === 'verifying') && (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Enter the 6-digit code
            </span>
            <OtpInput
              length={6}
              value={code}
              onChange={setCode}
              onComplete={handleCompleted}
              error={Boolean(error)}
              disabled={busy}
              label="Phone verification code"
            />
          </label>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={resendOtp}
              disabled={resendIn > 0 || busy}
              className="tap-target font-semibold text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
              aria-describedby={error ? 'phone-verify-error' : undefined}
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
            </button>
            {stage === 'verifying' && <span className="text-slate-500">Verifying…</span>}
          </div>
        </>
      )}

      {stage === 'success' && (
        <Alert kind="success">Phone verified. Redirecting…</Alert>
      )}

      <style jsx>{`
        @media (prefers-reduced-motion: reduce) {
          [data-testid="phone-verification-form"] {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>
    </div>
  );
}
