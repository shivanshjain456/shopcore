'use client';
/**
 * PincodeField — Feature #13.
 *
 *   A drop-in, accessible PIN code input with debounced India-Post-backed
 *   verification + autofill. Wraps the project's existing 6-digit-numeric
 *   input pattern with the production extras:
 *
 *     ┌─────────────────────────────────────────────────────────────────────┐
 *     │  ⌛ Verifying…   →   ✓ Bengaluru, Karnataka   (Verified by India Post)│
 *     │  PIN: [5 6 0 0 0 1]                                                  │
 *     │  Post office: [Bangalore G.P.O.    ▼]  (when there are ≥ 2)          │
 *     │  ┌──────────────────────────────┐                                    │
 *     │  │ 📍 Bengaluru                  │                                    │
 *     │  │    Karnataka — 560001         │  ← animated address card          │
 *     │  │    Verified by India Post     │                                    │
 *     │  └──────────────────────────────┘                                    │
 *     └─────────────────────────────────────────────────────────────────────┘
 *
 *   Behaviours:
 *     - DEBOUNCED lookup (DEFAULT_DEBOUNCE_MS, default 300ms) AFTER the
 *       user has typed exactly 6 digits.
 *     - RACE-SAFE: an AbortController + monotonic-counter guarantees that
 *       only the LATEST in-flight lookup is allowed to apply to state.
 *     - Multi-office case: a <select> appears; picking an office re-applies
 *       autofill from that office.
 *     - Manual override: the city/district/state fields are STILL editable
 *       after autofill; we never lock them.
 *     - Failure mode: if the lookup fails (or returns "not found"), the
 *       inline error appears under the PIN input but the form is NOT
 *       blocked — the user can complete the form by hand.
 *     - Accessibility: `aria-live="polite"` status row announces every
 *       state change to assistive tech; rule animation respects
 *       `prefers-reduced-motion`; the dropdown carries its own aria-label.
 *     - Pure presentational separation: parent owns the controlled values
 *       for { pinCode, city, state }. We expose them via `onAutofill`.
 */
import React, {
  ChangeEvent, useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import type { PincodeVerification, PostOffice } from '@/lib/pincode/types';
import { isValidPincodeFormat } from '@/lib/pincode/indiaPost';

/** Default debounce window. Spec: "300-500ms" — we pick the snappier end. */
const DEFAULT_DEBOUNCE_MS = 300;

export interface PincodeAutofill {
  pinCode: string;
  city: string;
  state: string;
  /** District (informational; the address schema has no district column,
   *  but downstream features like courier integration will need it). */
  district: string;
  /** Selected post-office object (informational). */
  postOffice: PostOffice | null;
  /** Whether the canonical state is currently serviceable. */
  isServiceable: boolean;
}

export interface PincodeFieldProps {
  /** Current pinCode value (controlled). */
  value: string;
  /** Called when the user types in the PIN input. */
  onChange: (next: string) => void;
  /** Called whenever a successful lookup yields a new autofill payload.
   *  Parent decides whether to overwrite already-typed city/state fields. */
  onAutofill?: (a: PincodeAutofill) => void;
  /** Required for label association. */
  name?: string;
  id?: string;
  /** Optional label text. Default "PIN code". */
  label?: string;
  /** Placeholder for the PIN input. */
  placeholder?: string;
  /** Disable the whole control. */
  disabled?: boolean;
  /** Debounce ms override (must be ≥ 0). */
  debounceMs?: number;
  /** Test override: replace the fetch path entirely. Default: `/api/pincode/{pin}`. */
  lookupPath?: (pin: string) => string;
  /** ARIA invalid styling. */
  'aria-invalid'?: boolean;
  /** Test hook so the page can drive the field. */
  'data-testid'?: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'typing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'verifying' }
  | { kind: 'verified'; result: PincodeVerification; selected: PostOffice }
  | { kind: 'not-found'; message: string }
  | { kind: 'error'; message: string };

export default function PincodeField({
  value,
  onChange,
  onAutofill,
  name = 'pinCode',
  id,
  label = 'PIN code',
  placeholder = '6-digit PIN',
  disabled = false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  lookupPath = (pin) => `/api/pincode/${pin}`,
  'aria-invalid': ariaInvalid,
  'data-testid': testId = 'pincode-field',
}: PincodeFieldProps) {
  const inputId = id ?? `pin-${name}`;
  const dropdownId = useId();
  const statusId = useId();

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Race-safety: every keystroke bumps `nextSeq`; the matching async path
  // only commits state if its sequence number is still the latest.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── handlers ──────────────────────────────────────────────────────────────
  const cancelInFlight = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current)    abortRef.current.abort();
  }, []);

  // Pure: apply a verification result to a chosen post office.
  const applyAutofill = useCallback((result: PincodeVerification, po: PostOffice) => {
    onAutofill?.({
      pinCode:   result.pincode,
      city:      po.region ?? po.division ?? po.district ?? result.city ?? '',
      state:     po.state ?? result.state ?? '',
      district:  po.district,
      postOffice: po,
      isServiceable: result.isServiceable,
    });
  }, [onAutofill]);

  // Cleanup on unmount.
  useEffect(() => () => cancelInFlight(), [cancelInFlight]);

  // Trigger a lookup when `value` changes to a complete 6-digit code.
  useEffect(() => {
    cancelInFlight();
    const v = (value ?? '').trim();
    if (v.length === 0) { setStatus({ kind: 'idle' }); return; }
    if (v.length < 6)   { setStatus({ kind: 'typing' }); return; }
    if (!isValidPincodeFormat(v)) {
      setStatus({ kind: 'invalid', message: 'PIN code must be 6 digits.' });
      return;
    }

    // 6 digits + valid format → schedule debounced lookup.
    const mySeq = ++seqRef.current;
    debounceRef.current = setTimeout(async () => {
      setStatus({ kind: 'verifying' });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(lookupPath(v), {
          signal: ctrl.signal,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        // Race check #1: discard if a newer keystroke beat us here.
        if (mySeq !== seqRef.current) return;
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean; data?: PincodeVerification; error?: string;
        };
        // Race check #2: re-validate after the await.
        if (mySeq !== seqRef.current) return;
        if (!json || (!json.ok && !json.data)) {
          setStatus({ kind: 'error', message: json?.error ?? 'Pincode lookup failed.' });
          return;
        }
        const data = json.data as PincodeVerification;
        if (!data.found || data.postOffices.length === 0) {
          setStatus({
            kind: 'not-found',
            message: data.message ?? 'Pincode not recognised. Please check and try again.',
          });
          return;
        }
        const selected = data.postOffices[0];
        setStatus({ kind: 'verified', result: data, selected });
        applyAutofill(data, selected);
      } catch (e) {
        const err = e as Error;
        // Race check: an AbortError from a stale request is not really
        // an error — swallow it. A genuine network failure → status.
        if (err.name === 'AbortError') return;
        if (mySeq !== seqRef.current) return;
        setStatus({
          kind: 'error',
          message: 'Could not verify pincode right now. Please enter address manually.',
        });
      }
    }, Math.max(0, debounceMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs]);

  // PIN typing handler.
  const onInput = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value.replace(/\D/g, '').slice(0, 6);
    onChange(next);
  }, [onChange]);

  // Post-office dropdown change.
  const onPickOffice = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    if (status.kind !== 'verified') return;
    const picked = status.result.postOffices.find((p) => p.name === e.target.value);
    if (!picked) return;
    setStatus({ kind: 'verified', result: status.result, selected: picked });
    applyAutofill(status.result, picked);
  }, [status, applyAutofill]);

  // ── visual helpers ────────────────────────────────────────────────────────
  const statusBadge = useMemo(() => {
    switch (status.kind) {
      case 'idle':
      case 'typing':    return null;
      case 'invalid':
      case 'not-found':
      case 'error':     return { dot: '✗', tone: 'text-red-700',     text: status.message };
      case 'verifying': return { dot: '⌛', tone: 'text-slate-600',   text: 'Verifying…' };
      case 'verified': {
        const head = status.selected;
        const city = head.region ?? head.division ?? head.district;
        return {
          dot: '✓',
          tone: status.result.isServiceable ? 'text-emerald-700' : 'text-amber-700',
          text: `${city}, ${head.state}`,
        };
      }
    }
  }, [status]);

  return (
    <div className={`flex flex-col gap-2`} data-testid={testId}>
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        {label}
        <span className="ml-0.5 text-red-500">*</span>
      </label>

      <div className="relative">
        <input
          id={inputId}
          name={name}
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="postal-code"
          maxLength={6}
          placeholder={placeholder}
          value={value}
          onChange={onInput}
          disabled={disabled}
          aria-invalid={ariaInvalid || (status.kind === 'invalid' || status.kind === 'not-found') || undefined}
          aria-describedby={statusId}
          data-testid={`${testId}-input`}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono tracking-[0.4em] text-slate-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 motion-reduce:transition-none"
        />
        {/* Inline trailing indicator — separate from the live region so the
            colour/scale animation doesn't conflict with the SR announcement. */}
        {statusBadge && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-2 flex items-center text-base ${statusBadge.tone} transition-opacity duration-200 ease-out motion-reduce:transition-none`}
            data-testid={`${testId}-badge`}
          >
            {statusBadge.dot}
          </span>
        )}
      </div>

      {/* Live region: announces verification state to screen readers. Visually
          shown only on non-idle states to keep the form quiet by default. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        data-testid={`${testId}-status`}
        className={[
          'min-h-[1.25rem] text-xs transition-opacity duration-200 motion-reduce:transition-none',
          status.kind === 'idle' || status.kind === 'typing' ? 'opacity-0' : 'opacity-100',
          statusBadge?.tone ?? 'text-slate-500',
        ].join(' ')}
      >
        {statusBadge?.text ?? ''}
      </p>

      {/* Multi-office dropdown. Only renders when there are 2+ post offices
          for this PIN. Selecting an office re-applies autofill. */}
      {status.kind === 'verified' && status.result.postOffices.length > 1 && (
        <div
          data-testid={`${testId}-multi`}
          className="animate-[fadeUp_220ms_ease-out_both] motion-reduce:animate-none"
        >
          <label
            htmlFor={dropdownId}
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Post office ({status.result.postOffices.length} options)
          </label>
          <select
            id={dropdownId}
            value={status.selected.name}
            onChange={onPickOffice}
            disabled={disabled}
            aria-label="Choose post office"
            data-testid={`${testId}-select`}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {status.result.postOffices.map((po) => (
              <option key={po.name} value={po.name}>
                {po.name}{po.branchType ? ` · ${po.branchType}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* "📍 …" address summary card. */}
      {status.kind === 'verified' && (
        <div
          role="group"
          aria-label="Verified delivery address summary"
          data-testid={`${testId}-card`}
          className={[
            'mt-1 rounded-lg border bg-white p-3 shadow-sm',
            status.result.isServiceable
              ? 'border-emerald-200 bg-emerald-50/60'
              : 'border-amber-200 bg-amber-50/60',
            'animate-[fadeUp_260ms_ease-out_both] motion-reduce:animate-none',
          ].join(' ')}
        >
          <div className="flex items-start gap-2 text-sm">
            <span aria-hidden="true" className="text-lg leading-none">📍</span>
            <div className="leading-snug">
              <div className="font-semibold text-slate-900">
                {status.selected.region ?? status.selected.division ?? status.selected.district}
              </div>
              <div className="text-slate-700">
                {status.selected.state} — {status.result.pincode}
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                <span aria-hidden="true">🛡</span>
                <span>Verified by India Post</span>
              </div>
              {!status.result.isServiceable && (
                <div
                  data-testid={`${testId}-unserviceable`}
                  className="mt-1 text-xs font-medium text-amber-700"
                >
                  Heads up: we may not currently deliver to this region. You can still proceed — we&apos;ll let you know during fulfilment.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Local keyframes — `<style jsx>` is scoped to this component. */}
      <style jsx>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
