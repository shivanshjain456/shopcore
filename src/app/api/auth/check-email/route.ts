/**
 * POST /api/auth/check-email — Feature #11 client-side availability hint.
 *
 * Returns `{ available: true | false, reason?: string }`. Intended ONLY for
 * the registration form's debounced availability hint (UX enhancement,
 * never the authority). The actual registration still re-validates and
 * returns the canonical 409 on collision.
 *
 * Privacy trade-off (accepted per the spec): this endpoint DOES reveal
 * email existence. The signup endpoint already returns a 409 for the same
 * case, so this endpoint doesn't introduce a new leak; it just moves the
 * disclosure earlier so the user gets immediate feedback. We mitigate
 * abuse with an aggressive per-IP rate limit (10/min) so it can't be
 * used to enumerate large email lists.
 *
 * Email format + allowlist also enforced here so the endpoint can't be
 * used as a generic "does this address belong to a real Gmail account"
 * probe — disallowed domains return `available: null` with a generic
 * policy message.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { prisma } from '@/lib/db/client';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import {
  checkEmailPolicy, devOnlyExtraAllowedDomains, EMAIL_POLICY_USER_MESSAGE,
} from '@/lib/auth/emailPolicy';

export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
}).strict();

export const POST = withErrorHandling(async (req: NextRequest) => {
  const ip = clientIp();
  // Aggressive limit per spec: 10/min/IP. We do NOT CSRF-protect this
  // endpoint — it's only read-only existence-check and CSRF on every
  // GET-shaped POST would break the debounced UX. Origin guard below
  // gives us same-origin safety.
  await applyRateLimit('auth.check_email', req);

  // Same-origin guard: cookies aren't required for this endpoint but we
  // still don't want a hostile site farming addresses through a logged-in
  // user's browser.
  const origin = req.headers.get('origin');
  const host   = req.headers.get('host');
  if (origin && host) {
    try { if (new URL(origin).host !== host) return jsonError('Cross-origin not allowed.', 403); }
    catch { return jsonError('Bad origin.', 403); }
  }

  const { email } = Body.parse(await req.json().catch(() => ({})));
  // If the address fails the allowlist / format / fraud filters, we
  // return a NEUTRAL response — neither "available" nor "taken" — so the
  // UI can render the same generic policy message. Avoids using this
  // endpoint as a Gmail/Outlook discriminator.
  const policy = checkEmailPolicy(email, { extraAllowedDomains: devOnlyExtraAllowedDomains() });
  if (!policy.ok) {
    return jsonOk({ available: null, reason: EMAIL_POLICY_USER_MESSAGE, normalized: policy.normalized });
  }
  const u = await prisma.user.findUnique({ where: { email: policy.normalized }, select: { id: true, status: true } });
  // PENDING_OTP is "still mine to finish" — we treat it as available so
  // the user can re-submit signup (the route then re-issues OTP).
  const taken = !!u && u.status !== 'PENDING_OTP';
  return jsonOk({
    available: !taken,
    normalized: policy.normalized,
    reason: taken ? 'An account with this email address already exists.' : undefined,
  });
});
