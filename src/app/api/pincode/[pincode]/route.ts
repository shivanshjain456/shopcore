/**
 * GET /api/pincode/[pincode] — Feature #13.
 *
 * Server-side proxy for the India Post Pincode API:
 *
 *   - Validates the {pincode} path parameter against /^\d{6}$/ BEFORE the
 *     external call — invalid format → 400 with no upstream traffic.
 *   - Delegates to `IndiaPostPincodeService` which serves from a 24h
 *     in-memory cache when warm.
 *   - Per-IP rate limiter (60 req / minute) — the upstream is free but we
 *     don't want a single client torching it.
 *   - Same-origin guard (Origin header host === request host) so the proxy
 *     can't be abused as an open CORS bridge.
 *   - Always returns 200 envelope `{ ok:true, data: {...} }` even on
 *     `found:false` — the spec says "do not block form submission on
 *     lookup failure" so the route surfaces the failure as data, not
 *     a non-2xx status.
 *
 * Why GET? The endpoint is idempotent + cacheable. No CSRF dance needed
 * because no state changes server-side. Path-only param so HTTP caches /
 * CDN proxies can key on the URL.
 */
import type { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { indiaPostPincodeService } from '@/lib/pincode/indiaPost';
import { isValidPincodeFormat } from '@/lib/pincode/indiaPost';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: NextRequest, ctx: { params: { pincode: string } }) => {
  // Per-IP cap (India Post is free + uncapped but we don't want a single
  // client to grief the proxy). Policy: pincode.lookup.
  await applyRateLimit('pincode.lookup', req);

  // Same-origin guard: the proxy is for THIS app's own forms. Anyone
  // else can hit api.postalpincode.in directly — no point in being an
  // open CORS bridge.
  const h = headers();
  const origin = h.get('origin');
  const host   = h.get('host');
  if (origin && host) {
    try {
      const oh = new URL(origin).host;
      if (oh !== host) {
        return jsonError('Cross-origin requests not allowed.', 403);
      }
    } catch { /* malformed origin header → ignore */ }
  }

  const pincode = (ctx.params.pincode ?? '').trim();
  if (!isValidPincodeFormat(pincode)) {
    // Return a structured "invalid format" envelope so the client UI
    // can render the same inline error path as a "not found" miss.
    return jsonOk({
      pincode,
      found: false, postOffices: [],
      state: null, district: null, city: null,
      isServiceable: false,
      source: 'unknown' as const,
      lookupMs: 0,
      message: 'PIN code must be exactly 6 digits.',
    }, { status: 400 });
  }

  const result = await indiaPostPincodeService.verifyPincode(pincode);

  // Long-cache the proxy response too. Postal boundaries are stable
  // for years, so we let intermediates (and the browser HTTP cache)
  // keep this for a day. The `stale-while-revalidate` keeps the UX
  // snappy if the upstream blips.
  return jsonOk(result, {
    headers: {
      'Cache-Control': result.found
        ? 'public, max-age=86400, stale-while-revalidate=604800'
        : 'public, max-age=60', // shorter for misses in case of upstream blip
    },
  });
});
