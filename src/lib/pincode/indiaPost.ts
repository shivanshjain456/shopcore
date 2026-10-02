/**
 * India Post Pincode service — Feature #13.
 *
 *   Endpoint: https://api.postalpincode.in/pincode/{PINCODE}
 *   - Free, no auth, no rate limits (per provider docs).
 *   - Returns an array of one or more results; each carries a Status field
 *     ("Success" | "Error" | "404") and a PostOffice array.
 *
 *   We:
 *     - validate format (6 digits) before hitting the network,
 *     - serve from an in-memory TTL cache (24 h) when possible,
 *     - bound the request with an AbortController timeout (5 s),
 *     - parse defensively (the upstream shape is occasionally wonky for
 *       sparsely-populated pincodes — missing fields, lower-cased state,
 *       etc.),
 *     - never throw to callers; lookup failures are converted to
 *       `found:false` results with a friendly `message`.
 *
 *   The cache is process-local (in-memory Map) which fits the project's
 *   single-Node deployment model. Swap for Redis later by replacing the
 *   `cache` object — the rest of the service is unchanged.
 */
import { canonicaliseState, isStateServiceable } from '@/lib/shipping/serviceableStates';
import { log } from '@/lib/log';
import { ExternalServiceError } from '@/lib/errors';
import type {
  PincodeService, PincodeVerification, PostOffice,
} from '@/lib/pincode/types';

// ── Tunables ───────────────────────────────────────────────────────────────
/** Cache TTL: India Post boundaries effectively never change. 24h is safe. */
export const PINCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard request ceiling so the proxy stays responsive on a flaky upstream. */
export const PINCODE_FETCH_TIMEOUT_MS = 5_000;
/** Soft cap on cache size — protects against memory blow-up under abuse. */
export const PINCODE_CACHE_MAX_ENTRIES = 5_000;

const INDIA_POST_BASE = 'https://api.postalpincode.in/pincode';

// ── In-memory TTL cache ────────────────────────────────────────────────────
interface CacheEntry {
  data: PincodeVerification;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Test-only cache reset. Never invoked outside test suites. */
export function _resetPincodeCache(): void { cache.clear(); }
/** Test-only cache stats. */
export function _pincodeCacheStats(): { size: number; max: number; ttlMs: number } {
  return { size: cache.size, max: PINCODE_CACHE_MAX_ENTRIES, ttlMs: PINCODE_CACHE_TTL_MS };
}

function cacheGet(pin: string): PincodeVerification | null {
  const e = cache.get(pin);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    cache.delete(pin);
    return null;
  }
  // Return a fresh copy with `source` flipped to 'cache' so callers can
  // detect a hit. Underlying postOffices array is structurally cloned so
  // callers cannot mutate the cached entry by accident.
  return { ...e.data, source: 'cache' };
}
function cachePut(pin: string, data: PincodeVerification): void {
  // Evict oldest if at cap.
  if (cache.size >= PINCODE_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(pin, { data, expiresAt: Date.now() + PINCODE_CACHE_TTL_MS });
}

// ── Format helpers ─────────────────────────────────────────────────────────
const PIN_FORMAT = /^\d{6}$/;
export function isValidPincodeFormat(s: unknown): s is string {
  return typeof s === 'string' && PIN_FORMAT.test(s);
}

// ── Upstream parsing ───────────────────────────────────────────────────────
/**
 * Upstream payload is an array; for valid pincodes:
 *   [{ Message, Status: "Success", PostOffice: [{ Name, BranchType,
 *      DeliveryStatus, Circle, District, Division, Region, Block, State,
 *      Country, Pincode }] }]
 *
 * For unknown pincodes:
 *   [{ Message: "No records found", Status: "Error", PostOffice: null }]
 *
 * We never trust shape — every field is read with optional chaining.
 */
interface RawPostOffice {
  Name?: unknown; BranchType?: unknown; DeliveryStatus?: unknown;
  District?: unknown; Division?: unknown; Region?: unknown; Circle?: unknown;
  Block?: unknown; State?: unknown; Country?: unknown; Pincode?: unknown;
}
interface RawResponse {
  Message?: unknown; Status?: unknown; PostOffice?: unknown;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function parsePostOffice(raw: RawPostOffice): PostOffice | null {
  const name = strOrNull(raw.Name);
  const district = strOrNull(raw.District);
  const rawState = strOrNull(raw.State);
  if (!name || !district || !rawState) return null;
  const canonicalState = canonicaliseState(rawState) ?? rawState;
  return {
    name,
    branchType:     strOrNull(raw.BranchType),
    deliveryStatus: strOrNull(raw.DeliveryStatus),
    district,
    division:       strOrNull(raw.Division),
    region:         strOrNull(raw.Region),
    circle:         strOrNull(raw.Circle),
    block:          strOrNull(raw.Block),
    state:          canonicalState,
    country:        strOrNull(raw.Country) ?? 'India',
  };
}

/** Pure: turn the upstream JSON into our normalised shape. Exported for unit tests. */
export function parseIndiaPostResponse(pincode: string, payload: unknown, lookupMs: number): PincodeVerification {
  const base: PincodeVerification = {
    pincode, found: false, postOffices: [],
    state: null, district: null, city: null,
    isServiceable: false, source: 'india-post', lookupMs,
  };
  if (!Array.isArray(payload) || payload.length === 0) {
    return { ...base, message: 'Pincode not recognised. Please check and try again.' };
  }
  const first = payload[0] as RawResponse;
  const status = String(first.Status ?? '').toLowerCase();
  if (status !== 'success' || !Array.isArray(first.PostOffice)) {
    return {
      ...base,
      message: typeof first.Message === 'string'
        ? first.Message
        : 'Pincode not recognised. Please check and try again.',
    };
  }
  const parsed = (first.PostOffice as RawPostOffice[])
    .map(parsePostOffice)
    .filter((p): p is PostOffice => p !== null);
  if (parsed.length === 0) {
    return { ...base, message: 'Pincode lookup returned an unexpected format. Please enter address manually.' };
  }
  // Use the first post office as the canonical address — every PO inside
  // a pincode shares the same district + state. The dropdown UI lets the
  // user pick a specific branch.
  const head = parsed[0];
  const canonicalState = canonicaliseState(head.state) ?? head.state;
  return {
    pincode,
    found: true,
    postOffices: parsed,
    state: canonicalState,
    district: head.district,
    // "City" in our address model corresponds to the locality the user
    // would actually write. We prefer Region > Division > District, in
    // that order, because Region is what India Post uses for "city".
    city: head.region ?? head.division ?? head.district,
    isServiceable: isStateServiceable(canonicalState),
    source: 'india-post',
    lookupMs,
  };
}

// ── Network helper ─────────────────────────────────────────────────────────
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      // Cache-control hint; the value here is the in-Node fetch cache,
      // not the public HTTP cache. We don't want Next to memoise it.
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Service implementation ─────────────────────────────────────────────────
export class IndiaPostPincodeService implements PincodeService {
  /** Override hook for tests — lets a test inject a mock fetcher. */
  protected async fetchUpstream(pincode: string): Promise<unknown> {
    const res = await fetchWithTimeout(`${INDIA_POST_BASE}/${pincode}`, PINCODE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      // Typed internal throw — caught in `verifyPincode` and converted
      // to a soft-fail result so callers never see this propagate.
      // We use ExternalServiceError so IF this leak surface ever
      // changes (e.g. a future caller wants `throw` semantics), the
      // central error router handles it correctly with a 502.
      throw new ExternalServiceError(
        `India Post upstream HTTP ${res.status}`,
        {
          code: `HTTP_${res.status}`,
          clientMessage: 'PIN code lookup is temporarily unavailable. Please enter address manually.',
          context: { service: 'india-post', upstreamStatus: res.status },
        },
      );
    }
    return res.json();
  }

  async verifyPincode(pincode: string): Promise<PincodeVerification> {
    // Bounce non-conforming input AT THE EDGE. Never make a network call
    // on invalid input — this is both a perf and an injection guard.
    if (!isValidPincodeFormat(pincode)) {
      return {
        pincode: String(pincode ?? ''),
        found: false, postOffices: [],
        state: null, district: null, city: null,
        isServiceable: false, source: 'unknown', lookupMs: 0,
        message: 'PIN code must be exactly 6 digits.',
      };
    }
    // Cache hit?
    const hit = cacheGet(pincode);
    if (hit) return hit;

    const startedAt = Date.now();
    try {
      const payload = await this.fetchUpstream(pincode);
      const parsed = parseIndiaPostResponse(pincode, payload, Date.now() - startedAt);
      // Cache BOTH successful + "not found" results — both are stable
      // for the 24h cache window and rejecting a known-bad pincode is
      // just as expensive as accepting a known-good one.
      cachePut(pincode, parsed);
      return parsed;
    } catch (e) {
      const err = e as Error & { code?: string; name?: string };
      const isAbort = err.name === 'AbortError';
      log.warn('pincode.lookup.failed', {
        pincode, errCode: err.code, errName: err.name, errMessage: err.message,
      });
      // We DO NOT cache failures — a transient network glitch must heal.
      return {
        pincode, found: false, postOffices: [],
        state: null, district: null, city: null,
        isServiceable: false, source: 'unknown',
        lookupMs: Date.now() - startedAt,
        message: isAbort
          ? 'Pincode lookup timed out. Please enter address manually.'
          : 'Could not verify pincode right now. Please enter address manually.',
      };
    }
  }
}

/** Default singleton — most callers should use this. */
export const indiaPostPincodeService: PincodeService = new IndiaPostPincodeService();
