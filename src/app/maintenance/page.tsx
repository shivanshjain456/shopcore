/**
 * /maintenance — full-page maintenance notice.
 *
 * Renders config-driven content (message + estimated end). No auth
 * required. Spec §2.5.
 *
 * If the estimated-end timestamp is missing or already in the past we
 * show a neutral "we'll be back soon" line instead of a stale ETA
 * (spec §3.9 edge case).
 */
import { getStoreConfig } from '@/lib/storeConfig';

export const dynamic = 'force-dynamic';

function formatEta(iso: string): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() <= Date.now()) return null;   // past → neutral copy
  return parsed.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function MaintenancePage() {
  const config = await getStoreConfig();
  const eta = formatEta(config.maintenance.maintenanceEstimatedEnd);
  const message = config.maintenance.maintenanceMessage
    || 'We are performing scheduled maintenance and will be back shortly.';

  return (
    <main className="min-h-[100vh] flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-2xl"
          aria-hidden="true"
        >
          ⚙
        </div>
        <h1 className="text-2xl font-bold text-slate-900">
          {config.store.name} is briefly offline
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          {message}
        </p>
        {eta ? (
          <p className="mt-4 text-xs text-slate-500">
            Expected back online: <strong className="text-slate-700">{eta}</strong>
          </p>
        ) : (
          <p className="mt-4 text-xs text-slate-500">We&apos;ll be back soon.</p>
        )}
        {config.store.supportEmail && (
          <p className="mt-6 text-xs text-slate-500">
            Urgent?{' '}
            <a
              href={`mailto:${config.store.supportEmail}`}
              className="font-semibold text-slate-700 underline"
            >
              {config.store.supportEmail}
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
