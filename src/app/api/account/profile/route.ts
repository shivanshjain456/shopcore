/**
 * PATCH /api/account/profile — Feature #11.
 *
 * Lets the signed-in user update first / last name, email, phone.
 * Uniqueness checks EXCLUDE the user's own row so a no-op update
 * (where email/phone are unchanged) succeeds. Updates with a different
 * email or phone enforce the same 409 contract as signup.
 *
 * Password change is out of scope here — use POST /api/account/password.
 *
 * The address fields live on a separate model and are managed via
 * /api/addresses, so they aren't included here.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import {
  checkEmailPolicy, devOnlyExtraAllowedDomains, EMAIL_POLICY_USER_MESSAGE,
} from '@/lib/auth/emailPolicy';
// Item 9: canonical phoneSchema.
import { phoneSchema } from '@/lib/auth/schemas';

export const dynamic = 'force-dynamic';

const Body = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName:  z.string().trim().min(1).max(60).optional(),
  email:     z.string().trim().toLowerCase().min(1).max(254).optional(),
  // Item 9: canonical phoneSchema (same normalisation everywhere).
  phone: phoneSchema.optional(),
}).strict();

function isPrismaUniqueViolation(e: unknown): { target: string[] } | null {
  const err = e as { code?: string; meta?: { target?: string[] | string } } | undefined;
  if (err?.code !== 'P2002') return null;
  const t = err.meta?.target;
  return { target: Array.isArray(t) ? t : (typeof t === 'string' ? [t] : []) };
}

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);

  const input = Body.parse(await req.json().catch(() => ({})));

  // Email — allowlist + uniqueness (exclude self)
  if (input.email && input.email !== user.email) {
    const policy = checkEmailPolicy(input.email, { extraAllowedDomains: devOnlyExtraAllowedDomains() });
    if (!policy.ok) return jsonError(EMAIL_POLICY_USER_MESSAGE, 400, { code: 'EMAIL_POLICY' });
    const other = await prisma.user.findUnique({ where: { email: policy.normalized }, select: { id: true } });
    if (other && other.id !== user.id) {
      return jsonError('An account with this email address already exists.', 409, { code: 'EMAIL_TAKEN' });
    }
  }
  // Phone — uniqueness (exclude self)
  if (input.phone && input.phone !== user.phone) {
    const other = await prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } });
    if (other && other.id !== user.id) {
      return jsonError('An account with this phone number already exists.', 409, { code: 'PHONE_TAKEN' });
    }
  }

  try {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        firstName: input.firstName ?? undefined,
        lastName:  input.lastName  ?? undefined,
        email:     input.email     ?? undefined,
        phone:     input.phone     ?? undefined,
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    return jsonOk({ user: updated });
  } catch (e) {
    const dup = isPrismaUniqueViolation(e);
    if (dup) {
      const onPhone = dup.target.some((t) => t.toLowerCase().includes('phone'));
      return jsonError(
        onPhone
          ? 'An account with this phone number already exists.'
          : 'An account with this email address already exists.',
        409,
        { code: onPhone ? 'PHONE_TAKEN' : 'EMAIL_TAKEN' },
      );
    }
    throw e;
  }
});
