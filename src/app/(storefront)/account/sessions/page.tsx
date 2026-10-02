'use client';
/**
 * /account/sessions — Feature #9 device management UI.
 *
 * Lists every active refresh-token family (= "signed-in device") for the
 * current user. Each row can be individually revoked. A "Sign out
 * everywhere except this device" button kicks every other family in one
 * call. The current device is clearly labelled and cannot be revoked from
 * the per-row button (use the standard Sign-out flow instead).
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { useDialog } from '@/components/dialog/DialogProvider';
import LogoutButton from '@/components/LogoutButton';

interface Session {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

function prettyUA(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (/iphone|ipod/i.test(ua))   return 'iPhone';
  if (/ipad/i.test(ua))          return 'iPad';
  if (/android/i.test(ua))       return 'Android';
  if (/macintosh|mac os x/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua))       return 'Windows';
  if (/linux/i.test(ua))         return 'Linux';
  return 'Browser';
}
function prettyBrowser(ua: string | null): string {
  if (!ua) return '';
  if (/edg\//i.test(ua))         return 'Edge';
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua))       return 'Firefox';
  if (/safari/i.test(ua) && !/chrome/i.test(ua))  return 'Safari';
  return '';
}

export default function SessionsPage() {
  const [list, setList] = useState<Session[] | null>(null);
  const [msg, setMsg]   = useState<string | null>(null);
  const dialog = useDialog();

  const load = async () => {
    const r = await api<{ sessions: Session[] }>('/api/auth/sessions');
    if (r.status === 401) { window.location.href = '/login?next=/account/sessions'; return; }
    setList(r.data?.sessions ?? []);
  };
  useEffect(() => { void load(); }, []);

  async function revokeOne(s: Session) {
    const ok = await dialog.confirm({
      title: 'Sign out this device?',
      message: `${prettyUA(s.userAgent)} · ${prettyBrowser(s.userAgent)} · IP ${s.ipAddress ?? 'unknown'}\n\nThe device will need to sign in again.`,
      intent: 'destructive', confirmLabel: 'Sign out device',
    });
    if (!ok) return;
    const r = await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
    if (!r.ok) {
      await dialog.alert({ title: 'Could not revoke', message: r.error ?? 'Please try again.' });
      return;
    }
    setMsg('Device signed out.');
    await load();
  }

  async function revokeOthers() {
    const ok = await dialog.confirm({
      title: 'Sign out other devices?',
      message: 'Every device except this one will be signed out and need to re-authenticate.',
      intent: 'destructive', confirmLabel: 'Sign out others',
    });
    if (!ok) return;
    const r = await api<{ revokedFamilies: number }>('/api/auth/logout-others', { method: 'POST', body: {} });
    if (!r.ok) {
      await dialog.alert({ title: 'Could not sign others out', message: r.error ?? 'Please try again.' });
      return;
    }
    setMsg(`Signed out of ${r.data?.revokedFamilies ?? 0} other device(s).`);
    await load();
  }

  if (!list) return <p className="text-sm text-slate-500">Loading sessions…</p>;

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Devices &amp; sessions</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={revokeOthers}
            data-testid="signout-others"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign out other devices
          </button>
          <LogoutButton variant="danger" scope="all" data-testid="signout-everywhere" />
        </div>
      </div>

      <p className="mt-1 text-sm text-slate-600">
        Each row represents an active sign-in. Revoke any you don&apos;t recognise.
      </p>

      {msg && <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}

      <ul className="mt-4 space-y-2">
        {list.length === 0 && (
          <li className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No active sessions.</li>
        )}
        {list.map((s) => (
          <li key={s.id} data-testid={`session-${s.id}`}
              className={`flex items-start justify-between gap-4 rounded-xl border bg-white p-4 ${s.current ? 'border-brand-300' : 'border-slate-200'}`}>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {prettyUA(s.userAgent)}
                {prettyBrowser(s.userAgent) && <span className="text-slate-500"> · {prettyBrowser(s.userAgent)}</span>}
                {s.current && (
                  <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase text-brand-800">This device</span>
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                IP {s.ipAddress ?? 'unknown'} · started {new Date(s.createdAt).toLocaleString('en-IN')}
              </p>
              <p className="text-xs text-slate-400">
                Auto-expires {new Date(s.absoluteExpiresAt).toLocaleString('en-IN')}
              </p>
            </div>
            {!s.current && (
              <button
                type="button"
                onClick={() => revokeOne(s)}
                data-testid={`revoke-${s.id}`}
                className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
