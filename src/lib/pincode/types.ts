/**
 * Pincode service — types & interface — Feature #13.
 *
 * The interface is intentionally narrow so we can swap providers (or stack
 * multiple — IndiaPost for ground truth + Shiprocket/Delhivery for courier
 * serviceability) without touching the UI or routes.
 *
 *   - verifyPincode(pin)             → core address autofill (this feature)
 *   - checkCourierAvailability(pin)? → future hook (Shiprocket, Delhivery,
 *                                       BlueDart, DTDC, Ecom Express, India
 *                                       Post Logistics, ...). Optional so
 *                                       implementations don't have to ship it
 *                                       on day one.
 */

/** A single post office within a pincode area. */
export interface PostOffice {
  /** Branch name, e.g. "Connaught Place S.O." */
  name: string;
  /** "S.O." (sub office) / "B.O." (branch office) / "H.O." (head office) */
  branchType?: string | null;
  /** "Delivery" / "Non-Delivery" — informational, not enforced. */
  deliveryStatus?: string | null;
  /** District the post office sits in (e.g. "New Delhi"). */
  district: string;
  /** Division / state-level area sometimes returned by India Post. */
  division?: string | null;
  /** Region (e.g. "Delhi"). */
  region?: string | null;
  /** Circle (e.g. "Delhi"). */
  circle?: string | null;
  /** Block / taluk if available. */
  block?: string | null;
  /** State (canonicalised when possible). */
  state: string;
  /** Country — always "India" for this provider. */
  country: string;
}

/** Normalised verification result returned by the proxy + the service. */
export interface PincodeVerification {
  /** 6-digit pincode that was looked up. */
  pincode: string;
  /** True iff the pincode exists in the upstream dataset. */
  found: boolean;
  /** All post offices reported for this pincode. May be ≥ 1 when found. */
  postOffices: PostOffice[];
  /** Canonical state derived from the first post office (or null). */
  state: string | null;
  /** Canonical district derived from the first post office. */
  district: string | null;
  /** First-line region the UI can show as "City" (district fallback). */
  city: string | null;
  /** True iff the canonical state is in our serviceability allowlist. */
  isServiceable: boolean;
  /** Provider that answered (for logs / diagnostics). */
  source: 'india-post' | 'cache' | 'unknown';
  /** Wall-clock ms it took us to look up — useful in tests. */
  lookupMs: number;
  /** Optional human-readable message for UI surfaces (especially on miss). */
  message?: string;
}

/** Lookup failure modes. */
export type PincodeLookupError =
  | { kind: 'INVALID_FORMAT'; pincode: string }
  | { kind: 'NOT_FOUND'; pincode: string }
  | { kind: 'NETWORK'; pincode: string; detail?: string }
  | { kind: 'TIMEOUT'; pincode: string }
  | { kind: 'BAD_RESPONSE'; pincode: string; detail?: string };

export interface PincodeService {
  verifyPincode(pincode: string): Promise<PincodeVerification>;
  /**
   * Future hook for courier integrations. Optional so non-courier-aware
   * providers (like India Post Pincode API) don't have to implement it.
   */
  checkCourierAvailability?(pincode: string): Promise<{
    pincode: string;
    couriers: Array<{ name: string; cod: boolean; prepaid: boolean; etaDays?: number }>;
  }>;
}
