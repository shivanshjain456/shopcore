/**
 * DEFAULT_STORE_CONFIG — the legacy nested shape (Item 5 / loyalty / policies /
 * b2b / shipping / hero). Moved here from `src/lib/config.ts` as part of
 * Item 8 (Admin Power Features). The src/lib/config.ts file now re-exports
 * from this module for backwards compatibility with the 10+ existing
 * importers — no caller had to change.
 *
 * This is the **legacy** half of the store-config contract. Item 8 adds a
 * second, flat-key contract (see schema.ts) covering features / payments /
 * shipping (extended) / checkout / loyalty (extended) / b2b (extended) /
 * notifications / security / performance / maintenance.
 *
 * Both halves coexist on the same `StoreConfig.data` JSON blob: legacy
 * callers continue to read `cfg.policies.cancellation.windowHours`; new
 * code reads `cfg.features.b2bEnabled`, etc. via `getStoreConfig()` from
 * `src/lib/storeConfig/index.ts`.
 */

export const DEFAULT_STORE_CONFIG = {
  store: {
    name: 'ShopCore',
    supportEmail: '',
    supportPhone: '',
    currency: 'INR',
    country: 'India',
  },
  policies: {
    cancellation: {
      enabled: true,
      windowHours: 24,            // cancel up to 24h after order, before SHIPPED
      allowedStatuses: ['PENDING_PAYMENT_REVIEW', 'PAYMENT_VERIFIED', 'PROCESSING'],
      refundMode: 'FULL',         // FULL | PARTIAL | STORE_CREDIT
    },
    returns: {
      enabled: true,
      windowDays: 7,              // 7 days from delivery
      excludedCategories: [] as string[],
      requirePhotos: true,
      restockingFeePercent: 0,
    },
    exchanges: {
      enabled: true,
      windowDays: 7,
      sameSkuOnly: false,
    },
    refunds: {
      method: 'ORIGINAL',         // ORIGINAL (back to UPI) | STORE_CREDIT
      processingDays: 5,
    },
  },
  shipping: {
    freeShippingMinPaise: 500000, // ₹5,000
    defaultShippingPaise: 9900,   // ₹99
  },
  loyalty: {
    enabled: true,
    // SAFE DEFAULT: 1 point per ₹100 spent (post-discount), floor-rounded.
    mode: 'PER_AMOUNT' as 'DISABLED' | 'PER_AMOUNT' | 'PERCENT',
    pointsPerAmount: 1,        // 1 point …
    amountUnitPaise: 10_000,   // … per ₹100 of basis
    percentBps: 0,             // (only used when mode='PERCENT'; 500 = 5%)
    eligibleBasis: 'SUBTOTAL_MINUS_DISCOUNT' as 'SUBTOTAL' | 'SUBTOTAL_MINUS_DISCOUNT',
    rounding: 'FLOOR' as 'FLOOR' | 'ROUND' | 'CEIL',
    minOrderPaise: 0,
    maxPointsPerOrder: null as number | null,
    redeemValuePaise: 100,     // 1 point = ₹1
    signupBonus: 50,
    referrerBonus: 200,
    refereeBonus: 100,
  },
  b2b: {
    requireGstin: true,
    requirePan: true,
    autoApprove: false,
  },
  hero: {
    autoplayMs: 6_000,
    resumeAfterMs: 1_500,
    hideWhenEmpty: false,
    showDots: true,
    showArrows: true,
  },
};

export type StoreConfigShape = typeof DEFAULT_STORE_CONFIG;
