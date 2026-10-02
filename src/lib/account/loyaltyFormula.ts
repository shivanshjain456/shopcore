/**
 * Loyalty earn formula — the SINGLE SOURCE OF TRUTH for converting an order
 * into earnable points.
 *
 * Admin-configurable via `StoreConfig.loyalty` (see `lib/config.ts`); never
 * hardcoded; never duplicated. Both `lib/checkout/placeOrder.ts` and
 * `lib/admin/orders.ts:verifyPayment()` MUST call `computeEarnedPoints()` —
 * a regression test asserts the two flows produce identical numbers.
 *
 * Modes:
 *   - DISABLED     : returns 0 always (also implied by `loyalty.enabled = false`)
 *   - PER_AMOUNT   : earn `pointsPerAmount` points per `amountUnitPaise` of basis
 *                    Example: pointsPerAmount=1, amountUnitPaise=1000 (=₹10)
 *                    → 1 point per ₹10 spent.
 *   - PERCENT      : earn `percentBps` basis-points of basis as points
 *                    (1 paise of basis × bps / 10_000 = points)
 *                    Example: percentBps=500 → 5% of order value as points.
 *                    NB: 1 point ≡ 1 paise of value here — convert to user-
 *                    facing pts using `redeemValuePaise` when displaying.
 *
 * Basis:
 *   - SUBTOTAL                — gross item subtotal (incl. tax, pre-discount)
 *   - SUBTOTAL_MINUS_DISCOUNT — what the customer actually paid for goods
 *                                (default — fair and prevents coupon farming)
 *
 * Rounding:
 *   - FLOOR (default) — never over-credits
 *   - ROUND           — banker rounding
 *   - CEIL            — only if admin opts in (e.g. for goodwill)
 *
 * Caps:
 *   - minOrderPaise       — below this, earn = 0
 *   - maxPointsPerOrder?  — optional ceiling
 *
 * All inputs are integers (paise); the output is an integer (points).
 * The function is PURE — no IO. Easy to unit-test exhaustively.
 */

export type LoyaltyMode     = 'DISABLED' | 'PER_AMOUNT' | 'PERCENT';
export type LoyaltyBasis    = 'SUBTOTAL' | 'SUBTOTAL_MINUS_DISCOUNT';
export type LoyaltyRounding = 'FLOOR' | 'ROUND' | 'CEIL';

/** Admin-editable settings persisted in StoreConfig.loyalty */
export interface LoyaltyConfig {
  enabled: boolean;
  mode: LoyaltyMode;

  // PER_AMOUNT
  pointsPerAmount: number;     // integer >= 0
  amountUnitPaise: number;     // integer >= 1 (e.g. 1000 = ₹10)

  // PERCENT
  percentBps: number;          // integer 0..10000 (10000 = 100%)

  // Basis + rounding + caps
  eligibleBasis: LoyaltyBasis;
  rounding: LoyaltyRounding;
  minOrderPaise: number;       // integer >= 0
  maxPointsPerOrder: number | null;

  // Display + redeem (existing fields preserved)
  redeemValuePaise: number;    // value of 1 point at checkout
  signupBonus: number;
  referrerBonus: number;
  refereeBonus: number;
}

export interface OrderForLoyalty {
  subtotalPaise: number;
  discountPaise: number;
}

export interface EarnedPointsResult {
  points: number;        // integer points to credit
  basisPaise: number;    // the basis we computed against (for the snapshot)
  reason: string;        // human-readable formula trace (for audit)
  capped: boolean;       // true if maxPointsPerOrder clamped the result
}

function roundBy(n: number, mode: LoyaltyRounding): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (mode) {
    case 'CEIL':  return Math.ceil(n);
    case 'ROUND': return Math.round(n);
    case 'FLOOR':
    default:      return Math.floor(n);
  }
}

/**
 * Pure function: given the formula config and the order, return the
 * integer number of points earned. NEVER returns a non-integer; NEVER
 * over-credits beyond the explicit cap.
 *
 * Defensive against bad config: any non-finite / negative value collapses
 * the branch to 0 points rather than crashing.
 */
export function computeEarnedPoints(cfg: LoyaltyConfig, order: OrderForLoyalty): EarnedPointsResult {
  // Disabled paths
  if (!cfg.enabled || cfg.mode === 'DISABLED') {
    return { points: 0, basisPaise: 0, reason: 'loyalty disabled', capped: false };
  }

  // Basis selection
  const basis =
    cfg.eligibleBasis === 'SUBTOTAL_MINUS_DISCOUNT'
      ? Math.max(0, (order.subtotalPaise | 0) - (order.discountPaise | 0))
      : Math.max(0, order.subtotalPaise | 0);

  // Minimum-order floor
  const minOrder = Math.max(0, cfg.minOrderPaise | 0);
  if (basis < minOrder) {
    return { points: 0, basisPaise: basis, reason: `basis ₹${basis / 100} < minOrder ₹${minOrder / 100}`, capped: false };
  }

  let rawPoints = 0;
  let reason = '';

  if (cfg.mode === 'PER_AMOUNT') {
    const ppa = Math.max(0, cfg.pointsPerAmount);
    const unit = Math.max(1, cfg.amountUnitPaise | 0);
    if (!Number.isFinite(ppa) || ppa <= 0) {
      return { points: 0, basisPaise: basis, reason: 'pointsPerAmount=0', capped: false };
    }
    // points = floor(basis / unit) * ppa  (deterministic; FLOOR by default)
    const units = Math.floor(basis / unit);
    rawPoints = units * ppa;
    reason = `PER_AMOUNT: ${ppa} pts per ₹${unit / 100} × ${units} units (basis ₹${basis / 100})`;
  } else if (cfg.mode === 'PERCENT') {
    const bps = Math.max(0, Math.min(10_000, cfg.percentBps | 0));
    if (bps === 0) {
      return { points: 0, basisPaise: basis, reason: 'percentBps=0', capped: false };
    }
    // Compute the cashback VALUE in paise, then convert to points by dividing
    // by redeemValuePaise. This way "5% of ₹51,990" → ₹2,599.50 cashback →
    // 2,599 points (when 1 pt = ₹1), NOT 259,950 points. Unit-consistent.
    const cashbackPaise = (basis * bps) / 10_000;
    const redeemValuePaise = Math.max(1, cfg.redeemValuePaise | 0);
    rawPoints = cashbackPaise / redeemValuePaise;
    reason = `PERCENT: ${bps / 100}% of basis ₹${basis / 100} (cashback ₹${(cashbackPaise / 100).toFixed(2)} ÷ ₹${(redeemValuePaise / 100).toFixed(2)} per point)`;
  }

  // Apply rounding
  let pts = roundBy(rawPoints, cfg.rounding);

  // Per-order cap
  let capped = false;
  if (cfg.maxPointsPerOrder != null && cfg.maxPointsPerOrder >= 0 && pts > cfg.maxPointsPerOrder) {
    pts = cfg.maxPointsPerOrder | 0;
    capped = true;
  }

  // Final defence
  pts = Math.max(0, pts | 0);

  return { points: pts, basisPaise: basis, reason: capped ? `${reason} (capped at ${cfg.maxPointsPerOrder})` : reason, capped };
}

/** Convenience: pull the LoyaltyConfig out of a parsed StoreConfig blob. */
export function toLoyaltyConfig(loyalty: Partial<LoyaltyConfig>): LoyaltyConfig {
  return {
    enabled:           loyalty.enabled ?? false,
    mode:              (loyalty.mode as LoyaltyMode) ?? 'DISABLED',
    pointsPerAmount:   Number(loyalty.pointsPerAmount ?? 0),
    amountUnitPaise:   Number(loyalty.amountUnitPaise ?? 10_000), // ₹100 unit by default
    percentBps:        Number(loyalty.percentBps ?? 0),
    eligibleBasis:     (loyalty.eligibleBasis as LoyaltyBasis) ?? 'SUBTOTAL_MINUS_DISCOUNT',
    rounding:          (loyalty.rounding as LoyaltyRounding) ?? 'FLOOR',
    minOrderPaise:     Number(loyalty.minOrderPaise ?? 0),
    maxPointsPerOrder: loyalty.maxPointsPerOrder == null ? null : Number(loyalty.maxPointsPerOrder),
    redeemValuePaise:  Number(loyalty.redeemValuePaise ?? 100),
    signupBonus:       Number(loyalty.signupBonus ?? 0),
    referrerBonus:     Number(loyalty.referrerBonus ?? 0),
    refereeBonus:      Number(loyalty.refereeBonus ?? 0),
  };
}
