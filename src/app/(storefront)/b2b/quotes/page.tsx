'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { rupees } from '@/lib/catalog/pricing';

interface QuoteRow {
  id: string; status: string; createdAt: string; updatedAt: string;
  lineCount: number; productNames: string[];
  quote: { quotedTotalPaise: number; discountPaise: number; expiresAt: string } | null;
}

export default function QuotesListPage() {
  const [list, setList] = useState<QuoteRow[] | null>(null);

  useEffect(() => {
    (async () => {
      const r = await api<{ quotes: QuoteRow[] }>('/api/b2b/quotes');
      if (r.status === 401) { window.location.href = '/login?next=/b2b/quotes'; return; }
      if (r.status === 403) { window.location.href = '/b2b/apply'; return; }
      setList(r.data?.quotes ?? []);
    })();
  }, []);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Quote requests</h1>
        <Link href="/b2b/quotes/new" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
          + New quote request
        </Link>
      </div>
      <ul className="mt-4 space-y-2">
        {list?.map((q) => (
          <li key={q.id}>
            <Link href={`/b2b/quotes/${q.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-300">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{q.lineCount} line(s)</p>
                  <p className="line-clamp-1 text-xs text-slate-500">{q.productNames.slice(0, 3).join(', ')}{q.productNames.length > 3 ? '…' : ''}</p>
                  <p className="text-xs text-slate-400">Updated {new Date(q.updatedAt).toLocaleString('en-IN')}</p>
                </div>
                <div className="text-right">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700">{q.status}</span>
                  {q.quote && (
                    <p className="mt-1 text-sm font-bold text-emerald-700">{rupees(q.quote.quotedTotalPaise)}</p>
                  )}
                </div>
              </div>
            </Link>
          </li>
        ))}
        {list && list.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No quote requests yet.</p>}
      </ul>
    </>
  );
}
