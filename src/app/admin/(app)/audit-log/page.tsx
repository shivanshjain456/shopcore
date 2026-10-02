'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { PageHeader, Card, Button } from '@/components/admin/Helpers';
import type { CursorPaginationMeta } from '@/lib/pagination';

interface Audit { id: string; action: string; entity: string; entityId: string | null; ipAddress: string | null; createdAt: string; before: string | null; after: string | null; actor: { email: string } }

export default function AuditLogPage() {
  const [items, setItems] = useState<Audit[]>([]);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  // Item 12 — cursor pagination. Stack remembers previous cursors so
  // "Prev" can walk back without keeping all rows client-side.
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([]);
  const [pagination, setPagination] = useState<CursorPaginationMeta | null>(null);

  const load = async () => {
    const qs = new URLSearchParams();
    if (entity) qs.set('entity', entity);
    if (action) qs.set('action', action);
    if (cursor) qs.set('cursor', cursor);
    const r = await api<{ items: Audit[]; pagination: CursorPaginationMeta }>(`/api/admin/audit-log?${qs.toString()}`);
    if (r.ok && r.data) { setItems(r.data.items); setPagination(r.data.pagination); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entity, action, cursor]);

  // When filters change, reset the cursor stack.
  useEffect(() => { setCursor(undefined); setCursorStack([]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entity, action]);

  const next = () => {
    if (!pagination?.nextCursor) return;
    setCursorStack((s) => [...s, cursor]);
    setCursor(pagination.nextCursor ?? undefined);
  };
  const prev = () => {
    setCursorStack((s) => {
      const copy = [...s];
      const last = copy.pop();
      setCursor(last);
      return copy;
    });
  };

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every admin action, timestamped." />
      <Card>
        <div className="flex gap-2">
          <input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="Filter entity (Product, Order, User…)" className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Filter action" className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </div>
      </Card>
      <Card className="mt-3 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">When</th><th className="px-3 py-2 text-left">Actor</th><th className="px-3 py-2 text-left">Action</th><th className="px-3 py-2 text-left">Entity</th><th className="px-3 py-2 text-left">IP</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((a) => (
              <tr key={a.id}>
                <td className="px-3 py-2 text-xs">{new Date(a.createdAt).toLocaleString('en-IN')}</td>
                <td className="px-3 py-2 text-xs">{a.actor.email}</td>
                <td className="px-3 py-2 text-xs font-semibold">{a.action}</td>
                <td className="px-3 py-2 text-xs"><code className="font-mono">{a.entity}{a.entityId ? `#${a.entityId.slice(0, 6)}…` : ''}</code></td>
                <td className="px-3 py-2 text-[10px] text-slate-500">{a.ipAddress ?? ''}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">No log entries.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Cursor pagination controls (Item 12) */}
      {pagination && (pagination.hasNextPage || cursorStack.length > 0) && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-end gap-2">
          <Button tone="ghost" disabled={cursorStack.length === 0} onClick={prev}>‹ Previous</Button>
          <Button tone="ghost" disabled={!pagination.hasNextPage} onClick={next}>Next ›</Button>
        </nav>
      )}
    </>
  );
}
