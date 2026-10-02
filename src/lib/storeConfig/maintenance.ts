/**
 * Maintenance-mode helpers — spec §2.5 + §3.4.
 *
 * Design:
 *   - The PATCH handler writes `data/maintenance.json` on every save so
 *     a future Edge-runtime middleware OR a non-app process (cron job,
 *     external probe) can read maintenance state cheaply without a DB
 *     hit.
 *   - The root server-layout (Node runtime) calls `isMaintenanceModeActive()`
 *     to redirect non-admin traffic to /maintenance. Because the root
 *     layout already runs on every page render and `getStoreConfig()`
 *     is cached, this DB hit is negligible. The file is purely an
 *     out-of-band signal for tooling.
 *
 * Edge-runtime note: spec called out that Next.js 14 middleware cannot
 * use `fs` (Edge). The brief recommended moving the redirect into the
 * root server layout; we did that. `data/maintenance.json` is therefore
 * an OBSERVABILITY artefact for cron jobs and ops dashboards, not the
 * primary gate.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '@/lib/log';
import type { UnifiedStoreConfig } from './index';

const MAINTENANCE_FILE = path.join(process.cwd(), 'data', 'maintenance.json');

export interface MaintenanceSnapshot {
  enabled:       boolean;
  message:       string;
  estimatedEnd:  string;
  allowedIps:    string[];
  /** Wall-clock ISO timestamp when this snapshot was written. */
  updatedAt:     string;
}

/**
 * Write `data/maintenance.json` from the current config. Called by the
 * PATCH handler whenever a `maintenance.*` key changes — kept idempotent
 * so callers don't have to diff.
 */
export async function syncMaintenanceFile(config: UnifiedStoreConfig): Promise<void> {
  const payload: MaintenanceSnapshot = {
    enabled:      config.maintenance.maintenanceMode,
    message:      config.maintenance.maintenanceMessage,
    estimatedEnd: config.maintenance.maintenanceEstimatedEnd,
    allowedIps:   config.maintenance.allowedMaintenanceIps,
    updatedAt:    new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(MAINTENANCE_FILE), { recursive: true });
  await fs.writeFile(MAINTENANCE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Read maintenance state from disk (cron jobs, ops scripts). Returns
 * `null` when the file doesn't exist (fresh install). The root layout
 * does NOT use this — it reads from `getStoreConfig()` directly.
 */
export async function readMaintenanceFile(): Promise<MaintenanceSnapshot | null> {
  try {
    const raw = await fs.readFile(MAINTENANCE_FILE, 'utf-8');
    return JSON.parse(raw) as MaintenanceSnapshot;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('maintenance.file_read_failed', { error: (e as Error).message });
    return null;
  }
}

/**
 * Decide whether a given client IP is allowed past the maintenance gate.
 * - Maintenance off → everyone passes.
 * - Maintenance on  → only IPs in the allow list pass.
 */
export function isIpAllowedDuringMaintenance(
  config: Pick<UnifiedStoreConfig, 'maintenance'>,
  clientIp: string | null,
): boolean {
  if (!config.maintenance.maintenanceMode) return true;
  if (!clientIp) return false;
  return config.maintenance.allowedMaintenanceIps.includes(clientIp);
}
