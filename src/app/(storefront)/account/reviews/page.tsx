'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface Eligible { id: string; slug: string; name: string; imageUrl: string | null }
interface MyReview { id: string; rating: number; title: string | null; body: string | null; isApproved: boolean; createdAt: string; product: Eligible }

export default function ReviewsPage() {
  const [eligible, setEligible] = useState<Eligible[] | null>(null);
  const [mine, setMine] = useState<MyReview[] | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Item 12 — pagination for the "Submitted reviews" list. The
  // "Awaiting your review" list above is short by design (delivered
  // products), so we don't paginate it.
  const [minePage, setMinePage] = useState(1);
  const [minePagination, setMinePagination] = useState<PaginationMeta | null>(null);

  const load = async () => {
    const [e, m] = await Promise.all([
      api<{ items: Eligible[]; pagination: PaginationMeta }>('/api/account/reviews?which=eligible'),
      api<{ items: MyReview[]; pagination: PaginationMeta }>(`/api/account/reviews?page=${minePage}`),
    ]);
    if (e.status === 401) { window.location.href = '/login?next=/account/reviews'; return; }
    setEligible(e.data?.items ?? []);
    setMine(m.data?.items ?? []);
    setMinePagination(m.data?.pagination ?? null);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [minePage]);

  async function submit() {
    if (!pid) return;
    setErr(null); setBusy(true);
    const r = await api('/api/account/reviews', { method: 'POST', body: { productId: pid, rating, title: title.trim() || null, body: body.trim() || null } });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not submit.'); return; }
    setPid(null); setRating(5); setTitle(''); setBody(''); await load();
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900">My reviews</h1>
      <p className="text-sm text-slate-600">You can review products from delivered orders. Reviews go live after admin approval.</p>

      {eligible && eligible.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase text-slate-600">Awaiting your review</p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {eligible.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-md border border-slate-200 p-2">
                {p.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt={p.name} className="h-12 w-16 rounded object-cover" />
                )}
                <span className="flex-1 text-sm">{p.name}</span>
                <button onClick={() => { setPid(p.id); setRating(5); }} className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700">Review</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pid && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold">Write a review</p>
          <div className="mt-2 flex items-center gap-1 text-xl">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} className={n <= rating ? 'text-amber-500' : 'text-slate-300'} aria-label={`${n} stars`}>★</button>
            ))}
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did you like or dislike?" rows={4} className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          {err && <p className="mt-2 text-sm text-red-700">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={submit} disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? 'Submitting…' : 'Submit'}</button>
            <button onClick={() => setPid(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button>
          </div>
        </div>
      )}

      <h2 className="mt-6 text-sm font-bold uppercase text-slate-700">Submitted reviews</h2>
      <ul className="mt-2 space-y-2">
        {mine?.map((r) => (
          <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <Link href={`/p/${r.product.slug}`} className="text-sm font-semibold hover:text-brand-700">{r.product.name}</Link>
              <span className="text-xs font-semibold text-slate-600">{r.isApproved ? '✓ Approved' : '⏳ Pending moderation'}</span>
            </div>
            <p className="text-amber-500">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</p>
            {r.title && <p className="text-sm font-semibold">{r.title}</p>}
            {r.body && <p className="text-sm text-slate-700">{r.body}</p>}
          </li>
        ))}
        {mine && mine.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">No reviews yet.</p>}
      </ul>
      {minePagination && (
        <Pagination
          currentPage={minePagination.page}
          totalPages={minePagination.totalPages}
          pageSize={minePagination.pageSize}
          totalItems={minePagination.total}
          onPageChange={(p) => setMinePage(p)}
        />
      )}
    </>
  );
}
