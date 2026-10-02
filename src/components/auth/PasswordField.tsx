'use client';
/**
 * PasswordField — Feature #11. Input + show/hide toggle (👁 / 🙈).
 *
 * The visibility toggle has `aria-pressed`, an `aria-label` that describes
 * the action ("Show password" / "Hide password"), and `type="button"` so
 * it never accidentally submits the parent form.
 *
 * The component intentionally does NOT include the strength meter — that's
 * a sibling so callers can render it once and feed the live value into it
 * directly, keeping the meter pure.
 */
import React, { useState } from 'react';

interface Props {
  name?: string;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'data-testid'?: string;
  /** Optional label text rendered above the input. */
  label?: string;
}

export default function PasswordField({
  name = 'password',
  id,
  value,
  onChange,
  onBlur,
  placeholder = 'Enter password',
  autoComplete = 'new-password',
  required,
  disabled,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'data-testid': testId = 'password-field',
  label,
}: Props) {
  const [visible, setVisible] = useState(false);
  const inputId = id ?? `pw-${name}`;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-xs font-semibold uppercase text-slate-600">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          data-testid={testId}
          className="w-full rounded-md border border-slate-300 px-3 py-2 pr-10 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          data-testid={`${testId}-toggle`}
          className="absolute inset-y-0 right-0 flex items-center px-2 text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          <span aria-hidden="true" className="text-base leading-none">{visible ? '🙈' : '👁'}</span>
        </button>
      </div>
    </div>
  );
}
