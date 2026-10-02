/**
 * Small composable auth guards for route handlers.
 *
 * Each guard returns either a `NextResponse` (caller should `return` it
 * to short-circuit) or `null` (proceed). They wrap the canonical
 * combinator pattern used in 30+ route handlers so the state-machine
 * checks are consistent, audit-discoverable, and impossible to forget
 * once a route opts into the guard.
 *
 * Usage:
 *
 *   const user = await getCurrentUser();
 *   const guard = requireWritePermitted(user);
 *   if (guard) return guard;
 *
 * Why not collapse into `getCurrentUser` itself?
 *
 *   `getCurrentUser` returns null for unauthenticated requests, but it
 *   ALSO returns the user object for PENDING_PHONE_VERIFICATION (login
 *   is permitted in that state so the user can resume the flow). The
 *   state-machine helpers `isOrderPermitted` / `isWritePermitted` are
 *   STRICTER than `isLoginPermitted` — they reject any state other than
 *   ACTIVE. Routes that mutate orders / write content need both checks
 *   in sequence, hence these small guards.
 */
import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/api';
import {
  isOrderPermitted, isWritePermitted, isLoginPermitted,
} from '@/lib/auth/accountStateHelpers';

interface UserShape {
  id: string;
  status: string;
}

/** Reject with 401 if the user is null. Returns `null` to proceed. */
export function requireAuthenticated(user: UserShape | null): NextResponse | null {
  if (!user) return jsonError('Please sign in.', 401, { code: 'UNAUTHENTICATED' });
  return null;
}

/** Reject with 403 if the user's status does not permit non-destructive
 *  writes (reviews, returns, wishlist, support tickets, saved carts).
 *  Assumes `user` is non-null; callers should chain with `requireAuthenticated`. */
export function requireWritePermitted(user: UserShape | null): NextResponse | null {
  const r = requireAuthenticated(user);
  if (r) return r;
  if (!isWritePermitted(user!.status)) {
    return jsonError(
      'Your account is not eligible to perform this action. Please complete verification or contact support.',
      403,
      { code: 'ACCOUNT_NOT_WRITE_PERMITTED', status: user!.status },
    );
  }
  return null;
}

/** Reject with 403 if the user's status does not permit placing orders.
 *  Equivalent to `requireWritePermitted` today (both require ACTIVE),
 *  exposed separately so future divergence (e.g. read-only "winding
 *  down" state) is a one-line change. */
export function requireOrderPermitted(user: UserShape | null): NextResponse | null {
  const r = requireAuthenticated(user);
  if (r) return r;
  if (!isOrderPermitted(user!.status)) {
    return jsonError(
      'Your account is not eligible to place orders. Please complete verification or contact support.',
      403,
      { code: 'ACCOUNT_NOT_ORDER_PERMITTED', status: user!.status },
    );
  }
  return null;
}

/** Re-export the helpers for routes that prefer the predicate style. */
export { isLoginPermitted, isOrderPermitted, isWritePermitted };
