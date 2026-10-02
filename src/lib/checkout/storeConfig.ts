/**
 * Backwards-compatibility shim.
 *
 * `getStoreConfig()` and `StoreConfigShape` previously lived here as the
 * canonical accessor for the StoreConfig singleton. Item 8 (Admin Power
 * Features) moved the canonical implementation to `@/lib/storeConfig` so
 * the new flat-key schema (features.*, payments.*, maintenance.*, etc.)
 * can coexist with the legacy nested shape (policies.*, hero.*).
 *
 * The returned object preserves every legacy field — the 15+ call sites
 * in checkout, account, totals, returns continue to read
 * `cfg.policies.cancellation.windowHours`, `cfg.shipping.freeShippingMinPaise`,
 * `cfg.loyalty.signupBonus`, etc. without modification.
 */
export { getStoreConfig } from '@/lib/storeConfig';
export type { UnifiedStoreConfig } from '@/lib/storeConfig';
