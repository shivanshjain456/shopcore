'use client';
/**
 * Sign-up page — Feature #11 premium UX.
 *
 *   - Controlled inputs (so we can drive the strength meter + email-check)
 *   - 400ms debounced email-availability check → spinner / ✓ / ✗
 *   - Live password strength meter + rule checklist (PasswordStrengthMeter)
 *   - Live "passwords match" / "passwords do not match" feedback
 *   - Show/hide toggle on both password fields (PasswordField)
 *   - Submission blocked when any required rule fails OR email known taken
 *     OR passwords don't match OR a required field is empty
 *   - Server is still the final authority (sees a 409/400 = surfaces it)
 *
 * The form uses local useState (project convention — no Formik/RHF).
 */
import { FormEvent, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell, Field, Alert, SubmitButton } from '@/components/AuthForm';
import { INDIAN_STATES } from '@/lib/enums';
import { api } from '@/lib/client/api';
import PasswordField from '@/components/auth/PasswordField';
import PasswordStrengthMeter from '@/components/auth/PasswordStrengthMeter';
import { validatePassword } from '@/lib/auth/passwordPolicy';
import PincodeField from '@/components/forms/PincodeField';
import PhoneField from '@/components/forms/PhoneField';

type EmailStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

function SignupInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const ref = sp.get('ref') ?? '';

  // ── Form state (controlled)
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [phone,     setPhone]     = useState('');
  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [address1,  setAddress1]  = useState('');
  const [address2,  setAddress2]  = useState('');
  const [city,      setCity]      = useState('');
  const [state,     setState]     = useState('');
  const [pinCode,   setPinCode]   = useState('');

  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [pwBlur,  setPwBlur]  = useState(false);  // controls error-style on rule list
  const [confirmTouched, setConfirmTouched] = useState(false);

  // ── Debounced email availability check
  const [emailStatus, setEmailStatus] = useState<EmailStatus>('idle');
  const [emailMsg,    setEmailMsg]    = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setEmailMsg(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!email || !email.includes('@')) { setEmailStatus('idle'); return; }
    setEmailStatus('checking');
    debounceRef.current = setTimeout(async () => {
      const r = await api<{ available: boolean | null; reason?: string }>(
        '/api/auth/check-email', { method: 'POST', body: { email } },
      );
      if (!r.ok) { setEmailStatus('idle'); return; }
      const data = r.data;
      if (data?.available === null) {
        setEmailStatus('invalid');
        setEmailMsg(data.reason ?? null);
      } else if (data?.available === true) {
        setEmailStatus('available');
      } else {
        setEmailStatus('taken');
        setEmailMsg(data?.reason ?? 'An account with this email address already exists.');
      }
    }, 400);  // 400ms per spec
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [email]);

  // ── Live password verdict (same validator the server uses)
  const passwordResult = useMemo(
    () => validatePassword(password, { email }),
    [password, email],
  );
  const passwordsMatch = confirm.length > 0 && password === confirm;

  // ── Submission gate
  const formReady =
    firstName.trim() && lastName.trim() && email.trim() && phone.trim() &&
    address1.trim() && address2.trim() && city.trim() && state && pinCode.trim() &&
    passwordResult.ok && passwordsMatch && emailStatus !== 'taken';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    // If we know the email is taken, don't even hit the server.
    if (emailStatus === 'taken') { setError(emailMsg ?? 'An account with this email address already exists.'); return; }
    // If our local check disagrees with the server, server still wins —
    // we just refuse to send when WE already know it's bad.
    if (!passwordResult.ok)  { setError(passwordResult.reason ?? 'Choose a stronger password.'); setPwBlur(true); return; }
    if (!passwordsMatch)     { setError('Passwords do not match.'); setConfirmTouched(true); return; }

    setBusy(true);
    const payload = {
      firstName, lastName, email, phone,
      password, confirmPassword: confirm,
      addressLine1: address1, addressLine2: address2,
      city, state, pinCode, country: 'India',
      ref: ref || undefined,
    };
    const r = await api<{ email: string; otpLength: number }>('/api/auth/signup', { method: 'POST', body: payload });
    setBusy(false);
    if (!r.ok) {
      // 409 EMAIL_TAKEN — reflect in the email status so the visual
      // indicator updates immediately even after a stale "available" check.
      const code = (r.raw as { code?: string } | undefined)?.code;
      if (code === 'EMAIL_TAKEN') { setEmailStatus('taken'); setEmailMsg(r.error ?? null); }
      setError(r.error ?? 'Signup failed.');
      return;
    }
    const e1 = r.data?.email ?? email;
    router.push(`/verify?email=${encodeURIComponent(e1)}&purpose=SIGNUP`);
  }

  return (
    <AuthShell
      title="Create your ShopCore account"
      subtitle={ref
        ? `You're signing up with referral code ${ref}. Both you and your friend earn bonus loyalty points.`
        : 'All fields are required. India only.'}
      footer={<>Already have an account? <a className="font-semibold text-brand-600 hover:underline" href="/login">Sign in</a></>}
    >
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" name="firstName">
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required
                   className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
          </Field>
          <Field label="Last name" name="lastName">
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required
                   className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
          </Field>
        </div>

        {/* EMAIL + availability indicator */}
        <Field label="Email address" name="email">
          <div className="relative">
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" required
                   data-testid="signup-email"
                   aria-describedby="email-status"
                   className={`block w-full rounded-lg border bg-white px-3 py-2 pr-10 text-sm shadow-sm outline-none focus:ring-2 ${
                     emailStatus === 'taken'    ? 'border-red-400     focus:border-red-500    focus:ring-red-100' :
                     emailStatus === 'invalid'  ? 'border-amber-400   focus:border-amber-500  focus:ring-amber-100' :
                     emailStatus === 'available'? 'border-emerald-400 focus:border-emerald-500 focus:ring-emerald-100' :
                                                  'border-slate-300   focus:border-brand-500  focus:ring-brand-100'
                   }`} />
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-sm transition-opacity motion-reduce:transition-none"
                  data-testid="email-status-icon" data-status={emailStatus}>
              {emailStatus === 'checking' && (
                <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600 motion-reduce:animate-none" />
              )}
              {emailStatus === 'available' && (<span aria-hidden="true" className="text-emerald-600">✓</span>)}
              {emailStatus === 'taken'     && (<span aria-hidden="true" className="text-red-600">✗</span>)}
              {emailStatus === 'invalid'   && (<span aria-hidden="true" className="text-amber-600">!</span>)}
            </span>
          </div>
          <p id="email-status" aria-live="polite" data-testid="email-status-text"
             className={`mt-1 min-h-[1rem] text-xs ${
               emailStatus === 'taken'     ? 'text-red-700' :
               emailStatus === 'invalid'   ? 'text-amber-700' :
               emailStatus === 'available' ? 'text-emerald-700' :
                                             'text-slate-500'
             }`}>
            {emailStatus === 'checking'  && 'Checking availability…'}
            {emailStatus === 'available' && 'Available — looks good.'}
            {emailStatus === 'taken'     && (emailMsg ?? 'An account with this email address already exists.')}
            {emailStatus === 'invalid'   && (emailMsg ?? 'Please use a valid personal email address from a supported provider.')}
          </p>
        </Field>

        {/* Item 9 — PhoneField renders a permanent, non-editable +91
            prefix beside the 10-digit input. `phone` state always holds
            the full E.164 string (the component composes it), so the
            existing `body.phone` POST below needs no further work. */}
        <PhoneField
          label="Phone number"
          name="phone"
          value={phone}
          onChange={setPhone}
          required
          hint="Enter your 10-digit mobile number."
        />

        {/* PASSWORD + strength meter + checklist */}
        <div className="space-y-2">
          <PasswordField
            label="Password"
            id="pw" name="password"
            value={password} onChange={setPassword}
            onBlur={() => setPwBlur(true)}
            autoComplete="new-password" required
            data-testid="signup-password"
            aria-invalid={!!password && !passwordResult.ok}
            aria-describedby="pw-meter"
          />
          <PasswordStrengthMeter
            password={password} email={email}
            showErrors={pwBlur}
          />
        </div>

        {/* CONFIRM */}
        <div className="space-y-1">
          <PasswordField
            label="Retype password"
            id="pw-confirm" name="confirmPassword"
            value={confirm} onChange={(v) => { setConfirm(v); setConfirmTouched(true); }}
            autoComplete="new-password" required
            data-testid="signup-confirm"
            aria-invalid={confirmTouched && !passwordsMatch}
            aria-describedby="confirm-status"
          />
          <p id="confirm-status" aria-live="polite" data-testid="confirm-status"
             className={`min-h-[1rem] text-xs ${
               !confirmTouched || confirm.length === 0 ? 'text-slate-500' :
               passwordsMatch                          ? 'text-emerald-700' :
                                                         'text-red-700'
             }`}>
            {confirmTouched && confirm.length > 0 && (passwordsMatch ? '✓ Passwords match' : '✗ Passwords do not match')}
          </p>
        </div>

        {/* ADDRESS */}
        <Field label="Address Line 1" name="addressLine1">
          <input value={address1} onChange={(e) => setAddress1(e.target.value)} autoComplete="address-line1" required
                 className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
        </Field>
        <Field label="Address Line 2" name="addressLine2">
          <input value={address2} onChange={(e) => setAddress2(e.target.value)} autoComplete="address-line2" required
                 className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="City" name="city">
            <input value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" required
                   className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
          </Field>
          <Field label="State" name="state">
            <select value={state} onChange={(e) => setState(e.target.value)} required
                    className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100">
              <option value="" disabled>Select state</option>
              {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {/* Feature #13 — debounced India-Post-backed pincode verification +
              autofill. Sets `city` and `state` automatically on a hit; the
              two fields above remain editable so manual overrides are kept. */}
          <PincodeField
            value={pinCode}
            onChange={setPinCode}
            onAutofill={(a) => {
              // Don't clobber a manually-typed city/state unless they're
              // empty — respects the spec's "autofilled fields editable"
              // rule by treating any prior text as user intent.
              if (!city.trim() && a.city)  setCity(a.city);
              if (!state && a.state)       setState(a.state);
            }}
            data-testid="signup-pincode"
          />
        </div>
        <Field label="Country" name="country">
          <input name="country" defaultValue="India" readOnly
                 className="block w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 shadow-sm" />
        </Field>

        <SubmitButton busy={busy} disabled={!formReady && !busy}>Create account</SubmitButton>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading…</div>}>
      <SignupInner />
    </Suspense>
  );
}
