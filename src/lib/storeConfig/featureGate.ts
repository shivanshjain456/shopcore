/**
 * Feature gating helper — Item 8 Phase 2.
 *
 * Use from any route handler:
 *
 *     await requireFeature('features.wishlistEnabled');
 *
 * Behaviour:
 *   - Reads `getStoreConfig()` (cached, 30 s in-process).
 *   - If `NODE_ENV === 'test'`, returns immediately. This is the
 *     explicit policy from spec §6.4: tests use the test-bypass strategy
 *     so the existing 1,902+ assertions don't have to mutate StoreConfig
 *     to exercise gated routes. Integration tests that DO want to verify
 *     gating set `SHOPCORE_ENFORCE_FEATURE_GATES=1` in the spawned
 *     child process to force enforcement.
 *   - On a disabled feature: throws `ForbiddenError` with
 *     `code: 'FEATURE_DISABLED'` and a per-feature `clientMessage`.
 *   - On a disabled MAINTENANCE-PAUSE flag (e.g. `maintenance.checkoutPaused`,
 *     `maintenance.registrationPaused`): throws with
 *     `code: 'FEATURE_PAUSED'` (still 403, but semantically distinct —
 *     "temporarily off" vs "permanently off"). Clients can present
 *     different copy.
 *
 * Generic over the schema's dot-key string so callers get autocomplete
 * AND a compile-time check that the gate name actually exists.
 */
import { ForbiddenError } from '@/lib/errors';
import { log } from '@/lib/log';
import { getStoreConfig } from '@/lib/storeConfig';
import type { ConfigKey } from '@/lib/storeConfig';

/** Gate-able config keys — every BOOLEAN entry. Narrowed at call sites
 *  to provide autocomplete; runtime check ignores the narrowing. */
type BooleanKey =
  // features.*
  | 'features.registrationEnabled' | 'features.guestCheckout'
  | 'features.emailAuthEnabled'    | 'features.phoneAuthEnabled'
  | 'features.phoneVerificationRequired'
  | 'features.wishlistEnabled'     | 'features.compareEnabled'
  | 'features.reviewsEnabled'      | 'features.reviewsRequirePurchase'
  | 'features.ratingsEnabled'
  | 'features.b2bEnabled'          | 'features.b2bRegistrationEnabled'
  | 'features.loyaltyEnabled'      | 'features.referralEnabled'
  | 'features.couponsEnabled'      | 'features.promotionsEnabled'
  | 'features.subscriptionsEnabled'| 'features.liveChat'
  | 'features.supportTickets'      | 'features.productShare'
  | 'features.quickView'           | 'features.recentlyViewed'
  | 'features.aiFeatures'
  // Item 18 — homepage CMS
  | 'features.homepageRevampEnabled' | 'features.homepageBrandsEnabled'
  | 'features.homepageMetricsEnabled' | 'features.homepageBranchesEnabled'
  // Item 19 — product gallery
  | 'products.galleryEnabled' | 'products.galleryLazyLoadEnabled'
  // Item 20 — gallery interaction
  | 'products.galleryInteractionsEnabled' | 'products.galleryZoomEnabled'
  | 'products.galleryFullscreenEnabled'   | 'products.galleryLoopEnabled'
  // payments.*
  | 'payments.upiEnabled'
  // maintenance pause switches
  | 'maintenance.registrationPaused'
  | 'maintenance.checkoutPaused';

// Compile-time check: every BooleanKey must be a ConfigKey.
type _Assert = BooleanKey extends ConfigKey ? true : never;
const _check: _Assert = true; void _check;

/** Per-feature user-facing copy. Anything not in this map falls back
 *  to a generic "currently disabled" line. */
const CLIENT_COPY: Partial<Record<BooleanKey, string>> = {
  'features.registrationEnabled':       'New account registration is currently disabled.',
  'features.emailAuthEnabled':          'Email + password sign-in is currently disabled.',
  'features.phoneAuthEnabled':          'Phone OTP sign-in is currently disabled.',
  'features.wishlistEnabled':           'The wishlist feature is currently disabled.',
  'features.compareEnabled':            'Product comparison is currently disabled.',
  'features.reviewsEnabled':            'Reviews are currently disabled.',
  'features.b2bEnabled':                'The B2B portal is currently disabled.',
  'features.b2bRegistrationEnabled':    'New B2B applications are currently closed.',
  'features.loyaltyEnabled':            'The loyalty program is currently disabled.',
  'features.couponsEnabled':            'Coupon redemption is currently disabled.',
  'features.liveChat':                  'Live chat is currently disabled.',
  'features.supportTickets':            'Support ticket submission is currently disabled.',
  'features.subscriptionsEnabled':      'Back-in-stock subscriptions are currently disabled.',
  'payments.upiEnabled':                'UPI payments are currently disabled.',
  'maintenance.registrationPaused':     'Account registration is temporarily paused. Please try again shortly.',
  'maintenance.checkoutPaused':         'Checkout is temporarily paused. Your cart has been saved — please try again shortly.',
};

/** Resolve a dot-key path against the unified config object. */
function readBool(cfg: Record<string, unknown>, key: BooleanKey): boolean {
  const [head, leaf] = key.split('.');
  const cat = cfg[head];
  if (cat === null || typeof cat !== 'object') return false;
  const val = (cat as Record<string, unknown>)[leaf];
  return val === true;
}

export interface RequireFeatureOptions {
  /** Override the user-facing message. */
  clientMessage?: string;
}

/**
 * Throw `ForbiddenError` if the given boolean feature flag is OFF (or,
 * for `maintenance.*Paused`, if the pause is ON).
 *
 *   await requireFeature('features.wishlistEnabled');
 *   await requireCheckoutNotPaused();      // convenience wrapper
 *   await requireRegistrationOpen();       // convenience wrapper
 */
export async function requireFeature(
  key: BooleanKey,
  opts: RequireFeatureOptions = {},
): Promise<void> {
  // Spec §6.4 test bypass — keep existing test suite green without
  // requiring every test to flip flags. Production / dev / staging
  // ALWAYS enforce.
  if (process.env.NODE_ENV === 'test'
      && process.env.SHOPCORE_ENFORCE_FEATURE_GATES !== '1') {
    return;
  }
  const config = await getStoreConfig();
  const isPauseKey = key.startsWith('maintenance.') && key.endsWith('Paused');
  // For "isEnabled" flags: pass requires TRUE.
  // For "isPaused"  flags: pass requires FALSE.
  const value = readBool(config as unknown as Record<string, unknown>, key);
  const blocked = isPauseKey ? value : !value;
  if (!blocked) return;

  const code = isPauseKey ? 'FEATURE_PAUSED' : 'FEATURE_DISABLED';
  log.info('feature_gate.blocked', { key, code });
  throw new ForbiddenError(`Feature gate "${key}" is closed.`, {
    code,
    clientMessage: opts.clientMessage ?? CLIENT_COPY[key]
      ?? (isPauseKey
        ? 'This action is temporarily paused. Please try again shortly.'
        : 'This feature is currently disabled.'),
    context: { feature: key },
  });
}

// ── Convenience wrappers for the most common gates ──────────────────────

export const requireRegistrationOpen   = (): Promise<void> => requireFeature('features.registrationEnabled');
export const requireRegistrationNotPaused = (): Promise<void> => requireFeature('maintenance.registrationPaused');
export const requireCheckoutNotPaused  = (): Promise<void> => requireFeature('maintenance.checkoutPaused');
export const requireWishlistEnabled    = (): Promise<void> => requireFeature('features.wishlistEnabled');
export const requireCompareEnabled     = (): Promise<void> => requireFeature('features.compareEnabled');
// Item 18 — homepage CMS gates.
export const requireHomepageRevampEnabled = (): Promise<void> => requireFeature('features.homepageRevampEnabled');
export const isHomepageRevampEnabled      = (): Promise<boolean> => isFeatureOn('features.homepageRevampEnabled');
export const isHomepageBrandsEnabled      = (): Promise<boolean> => isFeatureOn('features.homepageBrandsEnabled');
export const isHomepageMetricsEnabled     = (): Promise<boolean> => isFeatureOn('features.homepageMetricsEnabled');
export const isHomepageBranchesEnabled    = (): Promise<boolean> => isFeatureOn('features.homepageBranchesEnabled');
// Item 19 — product gallery gates.
export const isProductGalleryEnabled         = (): Promise<boolean> => isFeatureOn('products.galleryEnabled');
export const isProductGalleryLazyLoadEnabled = (): Promise<boolean> => isFeatureOn('products.galleryLazyLoadEnabled');
// Item 20 — gallery interaction gates.
export const isGalleryInteractionsEnabled    = (): Promise<boolean> => isFeatureOn('products.galleryInteractionsEnabled');
export const isGalleryZoomEnabled            = (): Promise<boolean> => isFeatureOn('products.galleryZoomEnabled');
export const isGalleryFullscreenEnabled      = (): Promise<boolean> => isFeatureOn('products.galleryFullscreenEnabled');
export const isGalleryLoopEnabled            = (): Promise<boolean> => isFeatureOn('products.galleryLoopEnabled');
export const requireReviewsEnabled     = (): Promise<void> => requireFeature('features.reviewsEnabled');
export const requireB2BEnabled         = (): Promise<void> => requireFeature('features.b2bEnabled');
export const requireB2BRegistrationOpen= (): Promise<void> => requireFeature('features.b2bRegistrationEnabled');
export const requireLiveChatEnabled    = (): Promise<void> => requireFeature('features.liveChat');
export const requireTicketsEnabled     = (): Promise<void> => requireFeature('features.supportTickets');
export const requireUpiEnabled         = (): Promise<void> => requireFeature('payments.upiEnabled');

/**
 * Non-throwing variant — useful in service modules where you want to
 * SKIP a side-effect rather than reject the whole request (e.g. don't
 * credit loyalty when loyalty is off).
 */
export async function isFeatureOn(key: BooleanKey): Promise<boolean> {
  if (process.env.NODE_ENV === 'test'
      && process.env.SHOPCORE_ENFORCE_FEATURE_GATES !== '1') {
    return true;
  }
  const config = await getStoreConfig();
  const isPauseKey = key.startsWith('maintenance.') && key.endsWith('Paused');
  const value = readBool(config as unknown as Record<string, unknown>, key);
  return isPauseKey ? !value : value;
}

/**
 * Read a numeric checkout limit from the config. Convenience wrapper
 * used by `/api/cart/add` and `/api/cart/update` so they don't each
 * reimplement the path walk + test bypass.
 */
export async function getCheckoutLimits(): Promise<{
  maxCartItems: number;
  maxQuantityPerItem: number;
}> {
  // In test, return the schema defaults so existing tests keep their
  // current behaviour (20 items, 10 per line).
  if (process.env.NODE_ENV === 'test'
      && process.env.SHOPCORE_ENFORCE_FEATURE_GATES !== '1') {
    return { maxCartItems: 20, maxQuantityPerItem: 10 };
  }
  const config = await getStoreConfig();
  return {
    maxCartItems:       config.checkout.maxCartItems,
    maxQuantityPerItem: config.checkout.maxQuantityPerItem,
  };
}
