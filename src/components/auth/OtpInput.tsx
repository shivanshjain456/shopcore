'use client';
/**
 * OtpInput — Feature #12.
 *
 * 6 (configurable) one-digit input slots with the polish users expect:
 *
 *   - auto-advance on input
 *   - backspace navigates to the previous slot when the current is empty
 *   - arrow-left / arrow-right move focus
 *   - paste of "123456" populates all slots in one shot
 *   - autoComplete="one-time-code" + inputMode="numeric" so SMS / iCloud
 *     suggestions surface on iOS / Android
 *   - aria-label on each slot ("Digit 1 of 6", etc.)
 *   - the whole group has role="group" + aria-label
 *
 * Controlled. Parent owns the string value; onChange fires with the
 * concatenated digits (≤ length). onComplete fires only when all slots
 * are filled — useful to auto-submit but caller may choose not to.
 *
 * Pure CSS transitions on focus/error; no third-party deps. Respects
 * prefers-reduced-motion.
 */
import React, {
  ChangeEvent, ClipboardEvent, KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef,
} from 'react';

interface Props {
  length?: number;                 // default 6
  value: string;                   // controlled
  onChange: (next: string) => void;
  onComplete?: (full: string) => void;
  /** When true, slots render in error styling. */
  error?: boolean;
  /** When true, slots are disabled. */
  disabled?: boolean;
  /** ARIA label for the whole group. */
  label?: string;
  /** Sets autofocus on slot 0 on mount. Default true. */
  autoFocus?: boolean;
}

export default function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
  error = false,
  disabled = false,
  label = 'One-time verification code',
  autoFocus = true,
}: Props) {
  const groupId = useId();
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  // Normalise the value to exactly `length` slots of either "" or one digit.
  const digits = useMemo<string[]>(() => {
    const out = Array.from({ length }, () => '');
    for (let i = 0; i < length && i < value.length; i++) {
      const ch = value.charAt(i);
      if (/^\d$/.test(ch)) out[i] = ch;
    }
    return out;
  }, [value, length]);

  useEffect(() => {
    if (autoFocus && refs.current[0]) refs.current[0].focus();
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emit onComplete whenever the value fills to `length` (one-shot per fill)
  const lastFiredRef = useRef<string>('');
  useEffect(() => {
    if (value.length === length && /^\d+$/.test(value) && value !== lastFiredRef.current) {
      lastFiredRef.current = value;
      onComplete?.(value);
    }
    if (value.length < length) lastFiredRef.current = '';
  }, [value, length, onComplete]);

  const setDigitAt = useCallback(
    (i: number, ch: string) => {
      const next = [...digits];
      next[i] = ch;
      onChange(next.join('').slice(0, length));
    },
    [digits, length, onChange],
  );

  const focusSlot = useCallback((i: number) => {
    const target = refs.current[Math.max(0, Math.min(length - 1, i))];
    target?.focus();
    target?.select();
  }, [length]);

  const handleChange = useCallback((i: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Filter to digits only. If the user types a multi-char value (some
    // mobile keyboards send the whole composed string), drop everything
    // but the first digit and forward the rest as a fake "paste".
    const onlyDigits = raw.replace(/\D/g, '');
    if (onlyDigits.length === 0) {
      setDigitAt(i, '');
      return;
    }
    if (onlyDigits.length === 1) {
      setDigitAt(i, onlyDigits);
      if (i < length - 1) focusSlot(i + 1);
      return;
    }
    // Multi-char: treat as a paste starting at slot i.
    const merged = digits.slice();
    let cursor = i;
    for (const d of onlyDigits) {
      if (cursor >= length) break;
      merged[cursor] = d;
      cursor++;
    }
    onChange(merged.join('').slice(0, length));
    focusSlot(Math.min(length - 1, cursor));
  }, [digits, length, focusSlot, onChange, setDigitAt]);

  const handleKeyDown = useCallback((i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    const key = e.key;
    if (key === 'Backspace') {
      // If the current slot is empty, jump back one and clear THAT slot.
      if (digits[i] === '' && i > 0) {
        e.preventDefault();
        const next = [...digits];
        next[i - 1] = '';
        onChange(next.join(''));
        focusSlot(i - 1);
      } else if (digits[i] !== '') {
        // Otherwise let the default handler clear the current slot; React
        // will fire onChange and we'll stay where we are.
      }
      return;
    }
    if (key === 'ArrowLeft')  { e.preventDefault(); focusSlot(i - 1); return; }
    if (key === 'ArrowRight') { e.preventDefault(); focusSlot(i + 1); return; }
    if (key === 'Home')       { e.preventDefault(); focusSlot(0); return; }
    if (key === 'End')        { e.preventDefault(); focusSlot(length - 1); return; }
    // Block non-digit single-char keys early — avoids the slot briefly
    // showing the typed letter before React re-renders.
    if (key.length === 1 && !/^\d$/.test(key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
    }
  }, [digits, length, onChange, focusSlot]);

  const handlePaste = useCallback((i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    const onlyDigits = text.replace(/\D/g, '');
    if (onlyDigits.length === 0) return;
    e.preventDefault();
    const merged = digits.slice();
    let cursor = i;
    for (const d of onlyDigits) {
      if (cursor >= length) break;
      merged[cursor] = d;
      cursor++;
    }
    onChange(merged.join('').slice(0, length));
    focusSlot(Math.min(length - 1, cursor));
  }, [digits, length, onChange, focusSlot]);

  const handleFocus = useCallback((i: number) => () => {
    // Convenience: when the user tabs into the group at a populated slot
    // they didn't intend to edit, jump to the FIRST empty slot. We only
    // do this when the focused slot has a value AND there's an earlier
    // empty slot — the natural "fill from the left" expectation. We
    // explicitly do NOT redirect focus when the landed-on slot is empty,
    // because that would clobber auto-advance after typing.
    if (digits[i] === '') return;
    const firstEmpty = digits.findIndex((d) => d === '');
    if (firstEmpty >= 0 && firstEmpty < i) focusSlot(firstEmpty);
  }, [digits, focusSlot]);

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={`${groupId}-hint`}
      className="flex items-center justify-center gap-2 sm:gap-3"
      data-testid="otp-input"
    >
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={d}
          onChange={handleChange(i)}
          onKeyDown={handleKeyDown(i)}
          onPaste={handlePaste(i)}
          onFocus={handleFocus(i)}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={error || undefined}
          data-testid={`otp-slot-${i}`}
          disabled={disabled}
          className={[
            'h-12 w-10 sm:h-14 sm:w-12 rounded-lg border bg-white text-center',
            'font-mono text-xl sm:text-2xl text-slate-900 shadow-sm outline-none',
            'transition-[border-color,box-shadow,transform] duration-150 ease-out motion-reduce:transition-none',
            'focus:scale-[1.04] motion-reduce:focus:scale-100',
            error
              ? 'border-red-500 focus:border-red-600 focus:ring-2 focus:ring-red-100 bg-red-50'
              : 'border-slate-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100',
            disabled ? 'opacity-60 cursor-not-allowed' : '',
          ].join(' ')}
        />
      ))}
      <span id={`${groupId}-hint`} className="sr-only">
        Enter the {length}-digit verification code sent to your email. You can paste the full code at once.
      </span>
    </div>
  );
}
