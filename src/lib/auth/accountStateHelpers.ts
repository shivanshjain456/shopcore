/**
 * Pure helpers extracted from `accountStateMachine.ts`.
 *
 * Why a separate file?
 *
 *   `accountStateMachine.ts` imports `revokeAllSessions` from
 *   `session.ts`. If `session.ts` (or any module session.ts depends on)
 *   imported helpers FROM `accountStateMachine.ts`, we'd get a module-
 *   load cycle. The cycle wouldn't crash (the helpers are simple
 *   functions and `session.ts` only uses them at call time, not at
 *   module-load time), but it would mean static analyzers flag the
 *   cycle AND we'd lose the ability to reason about evaluation order.
 *
 *   Splitting the pure helpers out keeps `session.ts → accountStateHelpers`
 *   one-way, and `accountStateMachine → { session.ts, accountStateHelpers }`
 *   also one-way. No cycle.
 *
 *   `accountStateMachine.ts` RE-EXPORTS every helper from this file so
 *   day-to-day call sites can keep importing from one place
 *   (`@/lib/auth/accountStateMachine`) — only the few modules that
 *   `accountStateMachine` itself depends on need to import from here
 *   directly.
 */
import { UserStatus, type UserStatus as UserStatusT } from '@/lib/enums';

/** Can this user log in (open a session) right now?
 *
 *  ACTIVE and PENDING_PHONE_VERIFICATION both permit login — the latter
 *  because the user has completed email verification and must be able
 *  to RESUME the flow on a fresh device (close-browser-then-relogin
 *  scenario). Middleware then redirects PENDING_PHONE_VERIFICATION
 *  sessions to `/verify-phone` for every protected route. */
export function isLoginPermitted(status: string): boolean {
  return status === UserStatus.ACTIVE
      || status === UserStatus.PENDING_PHONE_VERIFICATION;
}

/** Can this user place an order right now? ONLY ACTIVE — a user mid-phone-
 *  verification has not yet completed the security floor. */
export function isOrderPermitted(status: string): boolean {
  return status === UserStatus.ACTIVE;
}

/** Can this user perform non-destructive write actions? ONLY ACTIVE. */
export function isWritePermitted(status: string): boolean {
  return status === UserStatus.ACTIVE;
}

/** Is this status a terminal state (no transitions out)? */
export function isTerminal(status: string): boolean {
  return status === UserStatus.DELETED;
}

/** Is the supplied string a known UserStatus value? */
export function isKnownStatus(status: string): status is UserStatusT {
  return (Object.values(UserStatus) as string[]).includes(status);
}
