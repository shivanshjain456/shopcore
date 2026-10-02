/**
 * AnnouncementBanner — server component.
 *
 * Renders when `maintenance.bannerEnabled` is on AND `bannerExpiresAt`
 * is empty or in the future. Pulls colour palette from `bannerType`.
 *
 * Dismiss is handled by the inner client component below. State is
 * stored in `localStorage` keyed by the message hash, so if the admin
 * changes the message the banner reappears for every viewer.
 */
import { getStoreConfig } from '@/lib/storeConfig';
import { AnnouncementBannerClient } from './AnnouncementBannerClient';

export const dynamic = 'force-dynamic';

export async function AnnouncementBanner(): Promise<JSX.Element | null> {
  const config = await getStoreConfig();
  const m = config.maintenance;

  if (!m.bannerEnabled) return null;
  if (!m.bannerMessage.trim()) return null;
  if (m.bannerExpiresAt) {
    const expiresAt = new Date(m.bannerExpiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
      return null;   // expired
    }
  }

  // Stable key per message — if the admin edits the text, viewers see
  // the new banner even if they dismissed the previous one.
  const dismissKey = hash32(m.bannerMessage + ':' + m.bannerType);

  return (
    <AnnouncementBannerClient
      message={m.bannerMessage}
      type={m.bannerType}
      dismissKey={dismissKey}
    />
  );
}

// FNV-1a 32-bit hash — small, deterministic, no crypto dependency.
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
