'use client';
/**
 * Background Jobs admin dashboard — Item 7 Phase 2.
 *
 *   Shows: queue stats (cards), all jobs (filterable table), schedules
 *   (toggleable), per-row Retry / Cancel actions, per-row Details modal.
 *
 *   No live polling — the user clicks the "Refresh" button to re-fetch.
 *   Polling would add server load without much UX benefit; the queue
 *   moves on its own cadence and stats are an at-a-glance check.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePageSizePreference } from '@/lib/client/usePageSizePreference';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button, StatusBadge } from '@/components/admin/Helpers';
import { useDialog } from '@/components/dialog/DialogProvider';
import Pagination from '@/components/Pagination';
import type { PaginationMeta } from '@/lib/pagination';

interface JobRow {
  id: string; type: string; status: string;
  priority: number; attempts: number; maxAttempts: number;
  queueName: string;
  runAt: string; startedAt: string | null; completedAt: string | null;
  failedAt: string | null; createdAt: string; updatedAt: string;
  error: unknown; hasResult: boolean;
}
interface JobDetail extends JobRow {
  payload: unknown; result: unknown;
  parentJobId: string | null;
  lockToken: string | null; lockExpiresAt: string | null;
}
interface Stats {
  pending: number; processing: number; completed: number;
  failed: number; cancelled: number;
  oldestPending: string | null;
  avgCompletionMs: number | null;
  avgWindow: number;
}
interface Schedule {
  id: string; name: string; jobType: string;
  cronExpression: string; queueName: string;
  isActive: boolean;
  lastRunAt: string | null; nextRunAt: string;
  payload: unknown;
  createdAt: string; updatedAt: string;
}

const STATUS_TABS = ['ALL', 'PENDING', 'PROCESSING', 'FAILED', 'COMPLETED', 'CANCELLED'] as const;
type StatusTab = typeof STATUS_TABS[number];

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'medium' });
}
function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export default function JobsAdminPage() {
  const dialog = useDialog();
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tab, setTab] = useState<StatusTab>('ALL');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSizePreference('admin_jobs', 25);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (tab !== 'ALL') qs.set('status', tab);
      if (typeFilter.trim()) qs.set('type', typeFilter.trim());
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));

      const [s, j, sc] = await Promise.all([
        api<Stats>('/api/admin/jobs/stats'),
        api<{ items: JobRow[]; pagination: PaginationMeta }>(`/api/admin/jobs?${qs.toString()}`),
        api<{ items: Schedule[] }>('/api/admin/job-schedules'),
      ]);
      if (s.ok && s.data)  setStats(s.data);
      if (j.ok && j.data)  { setJobs(j.data.items); setPagination(j.data.pagination); }
      if (sc.ok && sc.data) setSchedules(sc.data.items);
    } finally {
      setBusy(false);
    }
  }, [tab, typeFilter, page, pageSize]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  async function openDetail(id: string) {
    const r = await api<{ job: JobDetail }>(`/api/admin/jobs/${id}`);
    if (r.ok && r.data) setDetail(r.data.job);
  }

  async function retry(id: string) {
    const ok = await dialog.confirm({
      title: 'Retry job?',
      message: 'This resets attempts to 0 and re-queues the job for immediate execution.',
      confirmLabel: 'Retry',
    });
    if (!ok) return;
    const r = await api(`/api/admin/jobs/${id}/retry`, { method: 'POST' });
    if (!r.ok) {
      await dialog.alert({ title: 'Retry failed', message: r.error ?? 'Unknown error.' });
      return;
    }
    await loadAll();
  }

  async function cancel(id: string) {
    const ok = await dialog.confirm({
      title: 'Cancel job?',
      message: 'The job will be marked CANCELLED and never executed.',
      confirmLabel: 'Cancel job',
    });
    if (!ok) return;
    const r = await api(`/api/admin/jobs/${id}/cancel`, { method: 'POST' });
    if (!r.ok) {
      await dialog.alert({ title: 'Cancel failed', message: r.error ?? 'Unknown error.' });
      return;
    }
    await loadAll();
  }

  async function toggleSchedule(s: Schedule) {
    const r = await api(`/api/admin/job-schedules/${s.id}`, {
      method: 'PATCH',
      body: { isActive: !s.isActive },
    });
    if (!r.ok) {
      await dialog.alert({ title: 'Update failed', message: r.error ?? 'Unknown error.' });
      return;
    }
    await loadAll();
  }

  return (
    <>
      <PageHeader
        title="Background jobs"
        subtitle="Queue health, recent jobs, and recurring schedules."
        actions={
          <Button tone="ghost" onClick={() => void loadAll()} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {/* ── Stats cards ───────────────────────────────────────────── */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatCard label="Pending"    value={stats?.pending    ?? '—'} tone="amber" />
        <StatCard label="Processing" value={stats?.processing ?? '—'} tone="blue"  />
        <StatCard label="Failed"     value={stats?.failed     ?? '—'} tone="red"   />
        <StatCard label="Completed"  value={stats?.completed  ?? '—'} tone="green" />
        <StatCard label="Cancelled"  value={stats?.cancelled  ?? '—'} tone="slate" />
      </div>
      <Card className="mb-3 flex flex-wrap items-center gap-4 text-xs text-slate-700">
        <span>
          <strong>Oldest pending:</strong>{' '}
          {stats?.oldestPending ? fmt(stats.oldestPending) : 'none'}
        </span>
        <span>
          <strong>Avg completion (last {stats?.avgWindow ?? 0}):</strong>{' '}
          {fmtMs(stats?.avgCompletionMs ?? null)}
        </span>
      </Card>

      {/* ── Filters + tabs ────────────────────────────────────────── */}
      <Card className="mb-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {STATUS_TABS.map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); setPage(1); }}
                className={`rounded-md px-3 py-1 text-xs font-semibold ${
                  tab === t ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <input
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
            placeholder="Filter by job type (e.g. send_email)"
            className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
      </Card>

      {/* ── Job rows ──────────────────────────────────────────────── */}
      <Card className="mb-4 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Attempts</th>
              <th className="px-3 py-2 text-left">Run at</th>
              <th className="px-3 py-2 text-left">Error</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">No jobs match.</td></tr>
            )}
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="px-3 py-2 text-xs">{fmt(j.createdAt)}</td>
                <td className="px-3 py-2 text-xs"><code className="font-mono">{j.type}</code></td>
                <td className="px-3 py-2"><StatusBadge s={j.status} /></td>
                <td className="px-3 py-2 text-xs">{j.attempts} / {j.maxAttempts}</td>
                <td className="px-3 py-2 text-xs">{fmt(j.runAt)}</td>
                <td className="px-3 py-2 text-xs text-red-700">
                  {j.error && typeof j.error === 'object'
                    ? (j.error as { code?: string }).code ?? 'error'
                    : ''}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    <Button tone="ghost" onClick={() => void openDetail(j.id)}>View</Button>
                    {j.status === 'FAILED' && (
                      <Button tone="amber" onClick={() => void retry(j.id)}>Retry</Button>
                    )}
                    {j.status === 'PENDING' && (
                      <Button tone="danger" onClick={() => void cancel(j.id)}>Cancel</Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ── Pagination (Item 12) ─────────────────────────────────── */}
      {pagination && (
        <div className="mb-6">
          <Pagination
            currentPage={pagination.page}
            totalPages={pagination.totalPages}
            pageSize={pagination.pageSize}
            totalItems={pagination.total}
            onPageChange={(p) => setPage(p)}
            showPageSizeSelector
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
            jumpInputThreshold={10}
            keyboardNav
          />
        </div>
      )}

      {/* ── Schedules ─────────────────────────────────────────────── */}
      <PageHeader title="Recurring schedules" subtitle="Cron-driven jobs the scheduler enqueues automatically." />
      <Card className="mb-6 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Job type</th>
              <th className="px-3 py-2 text-left">Cron (UTC)</th>
              <th className="px-3 py-2 text-left">Last run</th>
              <th className="px-3 py-2 text-left">Next run</th>
              <th className="px-3 py-2 text-right">Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {schedules.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 text-xs font-semibold">{s.name}</td>
                <td className="px-3 py-2 text-xs"><code className="font-mono">{s.jobType}</code></td>
                <td className="px-3 py-2 text-xs"><code className="font-mono">{s.cronExpression}</code></td>
                <td className="px-3 py-2 text-xs">{fmt(s.lastRunAt)}</td>
                <td className="px-3 py-2 text-xs">{fmt(s.nextRunAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    tone={s.isActive ? 'amber' : 'ghost'}
                    onClick={() => void toggleSchedule(s)}
                  >
                    {s.isActive ? 'On' : 'Off'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ── Detail modal (lightweight, no portal) ─────────────────── */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">Job {detail.id}</h2>
              <Button tone="ghost" onClick={() => setDetail(null)}>Close</Button>
            </div>
            <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-slate-500">Type</dt>           <dd><code>{detail.type}</code></dd>
              <dt className="text-slate-500">Status</dt>         <dd><StatusBadge s={detail.status} /></dd>
              <dt className="text-slate-500">Attempts</dt>       <dd>{detail.attempts} / {detail.maxAttempts}</dd>
              <dt className="text-slate-500">Queue</dt>          <dd>{detail.queueName}</dd>
              <dt className="text-slate-500">Created</dt>        <dd>{fmt(detail.createdAt)}</dd>
              <dt className="text-slate-500">Run at</dt>         <dd>{fmt(detail.runAt)}</dd>
              <dt className="text-slate-500">Started</dt>        <dd>{fmt(detail.startedAt)}</dd>
              <dt className="text-slate-500">Completed</dt>      <dd>{fmt(detail.completedAt)}</dd>
              <dt className="text-slate-500">Failed</dt>         <dd>{fmt(detail.failedAt)}</dd>
              <dt className="text-slate-500">Lock token</dt>     <dd className="break-all">{detail.lockToken ?? '—'}</dd>
            </dl>
            <h3 className="mb-1 mt-3 text-xs font-bold uppercase text-slate-500">Payload (PII masked)</h3>
            <pre className="overflow-auto rounded-md bg-slate-50 p-3 text-[11px]">{JSON.stringify(detail.payload, null, 2)}</pre>
            {detail.result !== null && (
              <>
                <h3 className="mb-1 mt-3 text-xs font-bold uppercase text-slate-500">Result</h3>
                <pre className="overflow-auto rounded-md bg-slate-50 p-3 text-[11px]">{JSON.stringify(detail.result, null, 2)}</pre>
              </>
            )}
            {detail.error !== null && (
              <>
                <h3 className="mb-1 mt-3 text-xs font-bold uppercase text-slate-500">Error</h3>
                <pre className="overflow-auto rounded-md bg-red-50 p-3 text-[11px] text-red-800">{JSON.stringify(detail.error, null, 2)}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone: 'amber' | 'blue' | 'red' | 'green' | 'slate' }) {
  const cls =
    tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
  : tone === 'blue'  ? 'border-sky-200   bg-sky-50   text-sky-800'
  : tone === 'red'   ? 'border-red-200   bg-red-50   text-red-800'
  : tone === 'green' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
  :                    'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div className={`rounded-xl border p-3 ${cls}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
