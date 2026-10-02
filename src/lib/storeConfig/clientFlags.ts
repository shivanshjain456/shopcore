/**
 * Server-side helper for projecting the unified store-config into the
 * small subset of boolean flags that are safe to ship to the browser.
 *
 * MUST live OUTSIDE `'use client'` files — Next.js wraps named exports
 * from `'use client'` modules as client-component references, which
 * cannot be called as plain functions from server code. (Symptom:
 * `TypeError: b is not a function` during layout render.)
 *
 * The companion `FeatureFlagProvider` (client component) imports the
 * SAME `ClientFeatureFlags` type from here so the prop shape stays in
 * sync.
 */
export interface ClientFeatureFlags {
  wishlistEnabled:        boolean;
  compareEnabled:         boolean;
  reviewsEnabled:         boolean;
  ratingsEnabled:         boolean;
  b2bEnabled:             boolean;
  loyaltyEnabled:         boolean;
  referralEnabled:        boolean;
  couponsEnabled:         boolean;
  promotionsEnabled:      boolean;
  subscriptionsEnabled:   boolean;
  liveChat:               boolean;
  supportTickets:         boolean;
  productShare:           boolean;
  quickView:              boolean;
  recentlyViewed:         boolean;
  aiFeatures:             boolean;
  guestCheckout:          boolean;
  registrationEnabled:    boolean;
  emailAuthEnabled:       boolean;
  phoneAuthEnabled:       boolean;
  checkoutPaused:         boolean;
  registrationPaused:     boolean;
}

/** Build a `ClientFeatureFlags` from any object that has the
 *  `features` + `maintenance` keys (i.e. the value `getStoreConfig()`
 *  returns). Defaults are safe: if a flag is missing for any reason,
 *  the user-facing copy assumes the feature is ON (the LEAST surprising
 *  default when something has gone wrong upstream). */
export function buildClientFlags(config: {
  features:    Record<string, unknown>;
  maintenance: Record<string, unknown>;
}): ClientFeatureFlags {
  const f = config.features as Record<string, boolean>;
  const m = config.maintenance as Record<string, boolean>;
  return {
    wishlistEnabled:        f.wishlistEnabled        ?? true,
    compareEnabled:         f.compareEnabled         ?? true,
    reviewsEnabled:         f.reviewsEnabled         ?? true,
    ratingsEnabled:         f.ratingsEnabled         ?? true,
    b2bEnabled:             f.b2bEnabled             ?? true,
    loyaltyEnabled:         f.loyaltyEnabled         ?? true,
    referralEnabled:        f.referralEnabled        ?? true,
    couponsEnabled:         f.couponsEnabled         ?? true,
    promotionsEnabled:      f.promotionsEnabled      ?? false,
    subscriptionsEnabled:   f.subscriptionsEnabled   ?? true,
    liveChat:               f.liveChat               ?? true,
    supportTickets:         f.supportTickets         ?? true,
    productShare:           f.productShare           ?? true,
    quickView:              f.quickView              ?? false,
    recentlyViewed:         f.recentlyViewed         ?? false,
    aiFeatures:             f.aiFeatures             ?? false,
    guestCheckout:          f.guestCheckout          ?? false,
    registrationEnabled:    f.registrationEnabled    ?? true,
    emailAuthEnabled:       f.emailAuthEnabled       ?? true,
    phoneAuthEnabled:       f.phoneAuthEnabled       ?? true,
    checkoutPaused:         m.checkoutPaused         ?? false,
    registrationPaused:     m.registrationPaused     ?? false,
  };
}
