'use client';
/**
 * FeatureFlagProvider — Item 8 Phase 2. Spec §3.5.
 *
 * Client components can't call `getStoreConfig()` (server-only). The
 * pattern is:
 *
 *   1. Server layout reads config + calls `buildClientFlags()` (from
 *      `@/lib/storeConfig/clientFlags` — NOT this file, see below).
 *   2. Server layout renders `<FeatureFlagProvider flags={...}>`.
 *   3. Any client component below calls `useFeatureFlags()` to read the
 *      current flag map and conditionally render.
 *
 * IMPORTANT: this file is `'use client'`. Named exports from a client
 * file get wrapped as client-component references — they can NOT be
 * called as plain functions from server code. That's why
 * `buildClientFlags` lives in a separate non-client module.
 *
 * Flags are read once per layout render — they never change client-side.
 * To pick up an admin's flag change, the customer just navigates (server
 * re-renders the layout) or hard-reloads. We don't push real-time flag
 * changes — that's a separate sprint.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ClientFeatureFlags } from '@/lib/storeConfig/clientFlags';

// Re-export the type so existing imports keep working.
export type { ClientFeatureFlags } from '@/lib/storeConfig/clientFlags';

/** Safe defaults — used when a client component is mounted OUTSIDE the
 *  provider tree (admin routes, error pages). Default is the LEAST
 *  surprising: every feature ON, no pause. The provider always wins
 *  inside the storefront layout. */
const DEFAULT_FLAGS: ClientFeatureFlags = {
  wishlistEnabled:        true,
  compareEnabled:         true,
  reviewsEnabled:         true,
  ratingsEnabled:         true,
  b2bEnabled:             true,
  loyaltyEnabled:         true,
  referralEnabled:        true,
  couponsEnabled:         true,
  promotionsEnabled:      false,
  subscriptionsEnabled:   true,
  liveChat:               true,
  supportTickets:         true,
  productShare:           true,
  quickView:              false,
  recentlyViewed:         false,
  aiFeatures:             false,
  guestCheckout:          false,
  registrationEnabled:    true,
  emailAuthEnabled:       true,
  phoneAuthEnabled:       true,
  checkoutPaused:         false,
  registrationPaused:     false,
};

const FeatureFlagContext = createContext<ClientFeatureFlags>(DEFAULT_FLAGS);

export function FeatureFlagProvider({
  flags,
  children,
}: {
  flags:    ClientFeatureFlags;
  children: ReactNode;
}): JSX.Element {
  return (
    <FeatureFlagContext.Provider value={flags}>
      {children}
    </FeatureFlagContext.Provider>
  );
}

export function useFeatureFlags(): ClientFeatureFlags {
  return useContext(FeatureFlagContext);
}
