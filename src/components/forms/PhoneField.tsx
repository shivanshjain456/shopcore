'use client';
/**
 * PhoneField — Item 9. Permanent, non-editable `+91` prefix + 10-digit
 * input. ShopCore is India-only; this is a UI and data contract, not a
 * feature toggle. There is intentionally NO `countryCode` prop.
 *
 *   ┌─────────────────────────────────────────┐
 *   │ Phone number *                          │
 *   │ ┌─────┬─────────────────────────────┐   │
 *   │ │ +91 │ 9 8 7 6 5 4 3 2 1 0         │   │   ← composite group; focus ring
 *   │ └─────┴─────────────────────────────┘   │     wraps the whole control
 *   │ Enter your 10-digit mobile number       │
 *   └─────────────────────────────────────────┘
 *
 * Contract (spec §2.1):
 *   - `value` is the FULL E.164 string (`+91XXXXXXXXXX`) or `''`.
 *   - `onChange(e164)` always receives `+91` + (0–10 digits). The parent
 *     decides when to submit; Zod validates the full 10-digit shape.
 *   - The `+91` element has `aria-hidden="true"` and is supplemented by
 *     a visually-hidden span so screen readers hear "Country code plus
 *     ninety-one" before the digit input.
 *   - Paste of any permissive Indian-phone format strips down to the
 *     10 national digits via the canonical `normalisePhone()`.
 *
 * Reference: `src/components/forms/PincodeField.tsx` (sibling component
 * pattern) and `src/components/AuthForm.tsx` (visual baseline).
 */
import React, {
  type ChangeEvent, type ClipboardEvent,
  useCallback, useId,
} from 'react';
import { normalisePhone, stripIndianPrefix } from '@/lib/utils/phone';

export interface PhoneFieldProps {
  /** Full E.164 value (`+919876543210`) or empty string. NOT bare digits. */
  value:        string;
  /** Called with the full E.164 string on every change. Bare partial
   *  values (e.g. `+91987`) are also valid mid-typing — the parent's
   *  submit handler validates the full 10-digit requirement. */
  onChange:     (e164: string) => void;
  /** Field label — rendered as `<label>`, associated via htmlFor/id. */
  label:        string;
  /** Optional id override. Default: generated via `useId()`. */
  id?:          string;
  /** Name attribute on the digit input. Default: `'phone'`. */
  name?:        string;
  /** Error message rendered below the field, associated via
   *  `aria-describedby`. Adds `aria-invalid="true"` to the input. */
  error?:       string;
  /** Disables the digit input; the `+91` prefix remains visible. */
  disabled?:    boolean;
  /** Adds HTML `required` + a visual asterisk on the label. */
  required?:    boolean;
  /** Focus the input on mount. */
  autoFocus?:   boolean;
  /** Placeholder shown in the digit input (no prefix — already visible).
   *  Default: `'9876543210'`. */
  placeholder?: string;
  /** Helper text below the field, associated via `aria-describedby`. */
  hint?:        string;
  /** Optional autocomplete hint forwarded to the input. Default `'tel-national'`. */
  autoComplete?: string;
  /** Test hook. */
  'data-testid'?: string;
}

export default function PhoneField({
  value,
  onChange,
  label,
  id,
  name = 'phone',
  error,
  disabled = false,
  required = false,
  autoFocus = false,
  placeholder = '9876543210',
  hint,
  autoComplete = 'tel-national',
  'data-testid': testId = 'phone-field',
}: PhoneFieldProps): JSX.Element {
  const autoId = useId();
  const inputId  = id ?? `phone-${autoId}`;
  const hintId   = `${inputId}-hint`;
  const errorId  = `${inputId}-error`;
  const prefixId = `${inputId}-prefix`;

  // Derive the display value from the controlled `value` prop — single
  // source of truth. The component holds NO internal state for the
  // digits. Defensive: an autofilled `+919876543210` and a legacy bare
  // `9876543210` both render as `9876543210`.
  const display = stripIndianPrefix(value);

  // Compose the full E.164 from arbitrary input digits.
  const emit = useCallback((digits: string) => {
    const clean = digits.replace(/\D+/g, '').slice(0, 10);
    onChange(`+91${clean}`);
  }, [onChange]);

  const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    emit(e.target.value);
  }, [emit]);

  // Paste handler — intercept BEFORE the browser applies its native
  // paste so we can strip prefixes / spaces / dashes from the pasted
  // material. Spec §3.2.
  const onPaste = useCallback((e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    const normalised = normalisePhone(pasted);
    if (normalised !== null) {
      e.preventDefault();
      emit(normalised.slice(3));     // strip +91, leaving 10 digits
      return;
    }
    // Pasted material doesn't normalise as an Indian phone. Fall back
    // to the digit-strip rule: extract whatever digits we got, cap at
    // 10. Better UX than silently ignoring the paste.
    const digitsOnly = pasted.replace(/\D+/g, '');
    if (digitsOnly.length > 0) {
      e.preventDefault();
      // Drop a leading-91 if a 12-digit paste is "91XXXXXXXXXX".
      const trimmed = digitsOnly.length === 12 && digitsOnly.startsWith('91')
        ? digitsOnly.slice(2)
        : digitsOnly.length === 11 && digitsOnly.startsWith('0')
          ? digitsOnly.slice(1)
          : digitsOnly;
      emit(trimmed.slice(0, 10));
    }
    // else: nothing useful in the clipboard, let the default no-op proceed.
  }, [emit]);

  // ── ARIA wiring for the input.
  // `aria-describedby` is a space-separated list of ids — hint AND/OR
  // error AND ALWAYS the prefix-announcement span (so the screen reader
  // hears the country code AFTER the label is announced).
  const describedBy = [
    prefixId,
    hint  ? hintId  : null,
    error ? errorId : null,
  ].filter(Boolean).join(' ');

  return (
    <div className="block" data-testid={testId}>
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500" aria-hidden="true">*</span>}
      </label>

      {/* Visually-hidden announcement read by screen readers — keeps the
          `+91` prefix audible WITHOUT the visual prefix element being
          its own focusable widget. Cf. spec §2.1 accessibility note. */}
      <span id={prefixId} className="sr-only">
        Country code plus ninety one
      </span>

      {/* Composite group. focus-within applies the focus ring to the
          entire control so the user sees a single field, not two. The
          ring respects prefers-reduced-motion via Tailwind's transition
          shorthand (no explicit animation property is used). */}
      <div
        className={[
          'tap-target flex w-full overflow-hidden rounded-lg border bg-white text-sm shadow-sm',
          'transition-colors',
          'focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100',
          error ? 'border-red-400' : 'border-slate-300',
          disabled ? 'opacity-60' : '',
        ].join(' ')}
      >
        {/* Non-editable prefix. `aria-hidden` so the screen reader
            doesn't read it twice (the sr-only span above already does
            that). Distinct background tone signals "this part is
            locked". `pointer-events: none` blocks click-to-focus on
            the prefix; clicks pass through to the input. */}
        <span
          aria-hidden="true"
          className="pointer-events-none inline-flex select-none items-center border-r border-slate-300 bg-slate-100 px-3 font-medium text-slate-600"
        >
          +91
        </span>

        <input
          id={inputId}
          name={name}
          type="tel"
          inputMode="numeric"
          // Pattern is 10 digits — kept loose enough that mid-typing
          // partial values don't trip browser validation; full
          // validation runs in Zod on the server.
          pattern="[0-9]{10}"
          maxLength={10}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          value={display}
          onChange={onInputChange}
          onPaste={onPaste}
          placeholder={placeholder}
          className="block w-full bg-white px-3 py-2 text-slate-900 outline-none disabled:bg-slate-50"
        />
      </div>

      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-slate-500">{hint}</p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
