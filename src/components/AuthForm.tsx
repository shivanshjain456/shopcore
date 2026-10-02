'use client';
/**
 * Shared building blocks for auth pages.
 * No external CDN / image dependencies — pure Tailwind.
 */
import { ReactNode } from 'react';

export function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-10">
        <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6">
            <a href="/" className="text-sm font-semibold text-brand-600">← ShopCore</a>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="mt-6 border-t border-slate-100 pt-4 text-center text-sm text-slate-600">{footer}</div>}
        </div>
      </div>
    </main>
  );
}

export function Field({
  label, name, type = 'text', required = true, autoComplete, defaultValue, placeholder, children,
}: {
  label: string; name: string; type?: string; required?: boolean;
  autoComplete?: string; defaultValue?: string; placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children ?? (
        <input
          name={name}
          type={type}
          required={required}
          autoComplete={autoComplete}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      )}
    </label>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'info' | 'success'; children: ReactNode }) {
  const cls =
    kind === 'error'   ? 'border-red-200 bg-red-50 text-red-800'
  : kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                       : 'border-blue-200 bg-blue-50 text-blue-800';
  return (
    <div role="alert" className={`mb-4 rounded-lg border px-3 py-2 text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function SubmitButton({ children, busy, disabled }: { children: ReactNode; busy?: boolean; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      // Feature #14 — `tap-target` enforces a 44×44 minimum and the explicit
      // py bump keeps the button comfortable on small phones.
      className="tap-target inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 sm:py-2.5"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}
