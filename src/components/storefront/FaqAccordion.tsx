'use client';
/**
 * FaqAccordion — Item 13.
 *
 * Accessible single-open accordion (only one panel expanded at a
 * time). Keyboard pattern follows WAI-ARIA Authoring Practices:
 *
 *   - Toggle button per item with `aria-expanded` + `aria-controls`.
 *   - Panel `<div role="region" aria-labelledby="…">`.
 *   - ArrowDown / ArrowUp moves focus between adjacent buttons
 *     (wraps at ends).
 *   - Home / End jump to first / last.
 *   - Enter / Space toggles (native button behaviour).
 *
 * Animation: `height: 0` ↔ measured `scrollHeight + 'px'` with a CSS
 * transition. `prefers-reduced-motion: reduce` suppresses the
 * transition class so toggles are instant. The panel stays in the DOM
 * + the a11y tree at all times — collapse is `height: 0; overflow:
 * hidden`, NOT `display: none`.
 */
import {
  type KeyboardEvent, type ReactNode,
  useCallback, useEffect, useId, useRef, useState,
} from 'react';

export interface FaqItem {
  question: string;
  answer:   ReactNode;
}

export default function FaqAccordion({ items }: { items: readonly FaqItem[] }): JSX.Element {
  const groupId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Refs to each toggle button — for arrow-key focus management.
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Refs to each panel for scrollHeight measurement.
  const panelRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Detect reduced-motion preference (server-safe — useEffect only runs client).
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const listener = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  const focusButton = useCallback((i: number) => {
    const node = btnRefs.current[i];
    if (node) node.focus();
  }, []);

  const onButtonKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusButton((i + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusButton((i - 1 + items.length) % items.length);
        break;
      case 'Home':
        e.preventDefault();
        focusButton(0);
        break;
      case 'End':
        e.preventDefault();
        focusButton(items.length - 1);
        break;
      // Enter / Space → native button click handles toggle.
      default:
    }
  }, [items.length, focusButton]);

  return (
    <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {items.map((item, i) => {
        const isOpen   = openIndex === i;
        const buttonId = `${groupId}-q${i}`;
        const panelId  = `${groupId}-p${i}`;

        // Measured panel height — `auto` would defeat the transition,
        // so we lock the closed state to `0` and the open state to the
        // current scrollHeight (re-measured each render — covers
        // dynamic-content cases per the spec).
        const measured = panelRefs.current[i]?.scrollHeight ?? 0;
        const panelStyle: React.CSSProperties = reducedMotion
          ? { height: isOpen ? 'auto' : 0, overflow: 'hidden' }
          : {
              height: isOpen ? `${measured}px` : 0,
              overflow: 'hidden',
              transition: 'height 200ms ease-out',
            };

        return (
          // Edge-case D7.4 — use the question string as the stable key.
          // FAQ items are fixed-shape and the questions are unique by
          // construction, so the question string is a more correct key
          // than a positional index and keeps the audit clean.
          <div key={item.question}>
            <h3 className="m-0">
              <button
                ref={(el) => { btnRefs.current[i] = el; }}
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                onKeyDown={(e) => onButtonKeyDown(e, i)}
                className="tap-target flex w-full items-center justify-between gap-3 px-4 py-4 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span>{item.question}</span>
                {/* Chevron — rotates 180° when open. CSS transform; the
                    reduced-motion path skips the transition via the
                    parent's transition omission. */}
                <span
                  aria-hidden="true"
                  className={`flex-none text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  style={reducedMotion ? { transition: 'none' } : undefined}
                >
                  ▾
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              style={panelStyle}
              ref={(el) => { panelRefs.current[i] = el; }}
            >
              <div className="px-4 pb-4 text-sm leading-relaxed text-slate-700">
                {item.answer}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
