'use client';

import { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`}>{children}</div>;
}

export function StatusBadge({ s }: { s: string }) {
  const cls =
    /APPROVED|VERIFIED|DELIVERED|ACTIVE|ok/i.test(s) ? 'bg-emerald-100 text-emerald-800'
  : /PENDING|AWAITING|REQUESTED|OPEN|PROCESSING|PACKED|SHIPPED/i.test(s) ? 'bg-amber-100 text-amber-800'
  : /REJECTED|CANCELLED|FAILED|DECLINED|REFUNDED|SUSPENDED|DELETED/i.test(s) ? 'bg-red-100 text-red-800'
  : 'bg-slate-100 text-slate-700';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${cls}`}>{s.replace(/_/g, ' ')}</span>;
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'amber' }) {
  const { tone = 'primary', className, ...rest } = props;
  const cls =
    tone === 'primary' ? 'bg-brand-600 text-white hover:bg-brand-700'
  : tone === 'amber'   ? 'bg-amber-500 text-white hover:bg-amber-600'
  : tone === 'danger'  ? 'border border-red-300 bg-white text-red-700 hover:bg-red-50'
                       : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
  return <button {...rest} className={`rounded-md px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${cls} ${className ?? ''}`} />;
}
