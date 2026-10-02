'use client';
/**
 * PasswordStrengthMeter — Feature #11 UI.
 *
 * Pure-presentational: takes the password value (+ optional email for the
 * "no email name" rule) and renders:
 *   - 5-segment animated meter with progressive fill
 *   - Numeric/textual strength label (Weak → Very Strong)
 *   - Live checklist of each rule (with status + label)
 *   - aria-live region announces the level to screen readers
 *
 * Uses the SAME validator (`lib/auth/passwordPolicy.ts`) the server runs —
 * meter result === server verdict, by construction.
 *
 * Animation: CSS transitions on `transform: scaleX(...)` and `opacity` —
 * no layout shifts. Respects `prefers-reduced-motion`.
 *
 * Accessibility:
 *   - Each rule has `role="listitem"` inside a `role="list"`
 *   - Pass/fail uses both an icon AND a colour AND a text status — never
 *     colour alone
 *   - `aria-live="polite"` on the level announcement
 */
import React, { useMemo } from 'react';
import { validatePassword, type PasswordStrengthLevel, type PasswordRule } from '@/lib/auth/passwordPolicy';

interface Props {
  password: string;
  email?: string | null;
  /** When true, show unsatisfied rules in error styling (e.g. after blur). */
  showErrors?: boolean;
  className?: string;
}

const LEVEL_COLOR: Record<PasswordStrengthLevel, string> = {
  'Weak':        'bg-red-500',
  'Fair':        'bg-orange-500',
  'Good':        'bg-yellow-500',
  'Strong':      'bg-emerald-500',
  'Very Strong': 'bg-emerald-700',
};
const LEVEL_TEXT: Record<PasswordStrengthLevel, string> = {
  'Weak':        'text-red-700',
  'Fair':        'text-orange-700',
  'Good':        'text-yellow-700',
  'Strong':      'text-emerald-700',
  'Very Strong': 'text-emerald-800',
};

/** A single segment of the 5-bar meter. Animates its `scaleX` 0→1 when
 *  it becomes the current level (smooth fill, GPU-accelerated). */
function Segment({ filled, color }: { filled: boolean; color: string }) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
      <div
        className={`h-full origin-left rounded-full ${color} transition-transform duration-300 ease-out motion-reduce:transition-none`}
        style={{ transform: filled ? 'scaleX(1)' : 'scaleX(0)' }}
      />
    </div>
  );
}

function CheckIcon({ ok, error }: { ok: boolean; error: boolean }) {
  if (ok) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 transition-colors motion-reduce:transition-none"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none ${
        error ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-400'
      }`}
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function RuleRow({ rule, showErrors }: { rule: PasswordRule; showErrors: boolean }) {
  const ok = rule.satisfied;
  const error = !ok && showErrors;
  return (
    <li
      role="listitem"
      data-testid={`pwrule-${rule.id}`}
      data-status={ok ? 'ok' : error ? 'error' : 'pending'}
      className={`flex items-center gap-2 text-xs transition-colors motion-reduce:transition-none ${
        ok ? 'text-emerald-800' : error ? 'text-red-700' : 'text-slate-600'
      }`}
    >
      <CheckIcon ok={ok} error={error} />
      <span>{rule.label}</span>
      <span className="sr-only">{ok ? 'satisfied' : 'not yet satisfied'}</span>
    </li>
  );
}

export default function PasswordStrengthMeter({ password, email, showErrors = false, className }: Props) {
  const result = useMemo(
    () => validatePassword(password, { email: email ?? null }),
    [password, email],
  );

  // Don't render anything until the user has started typing — keeps the
  // form quiet on first paint.
  if (!password) return null;

  const color = LEVEL_COLOR[result.level];
  const textColor = LEVEL_TEXT[result.level];

  return (
    <div className={`mt-2 ${className ?? ''}`} data-testid="pw-meter">
      {/* 5-segment meter */}
      <div className="flex items-center gap-1" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((seg) => (
          <Segment key={seg} filled={result.score >= seg} color={color} />
        ))}
      </div>

      {/* Strength label — announced to screen readers via aria-live */}
      <p
        className={`mt-1 flex items-center justify-between text-xs font-semibold ${textColor}`}
        aria-live="polite"
        data-testid="pw-strength-label"
        data-level={result.level}
        data-score={result.score}
      >
        <span>Password strength: {result.level}</span>
        <span aria-hidden="true">{result.score}/5</span>
      </p>

      {/* Rule checklist */}
      <ul role="list" className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2" data-testid="pw-rules">
        {result.rules.map((r) => (
          <RuleRow key={r.id} rule={r} showErrors={showErrors} />
        ))}
      </ul>
    </div>
  );
}
