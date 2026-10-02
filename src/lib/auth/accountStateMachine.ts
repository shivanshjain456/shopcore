/**
 * Account State Machine — the single source of truth for the account
 * lifecycle. Every transition of `User.status` MUST flow through this
 * module — direct `prisma.user.update({ data: { status: ... } })` calls
 * are a defect (the static audit in `scripts/test-account-state-machine.ts`
 * will flag them unless they carry a `STATE_MACHINE_BYPASS:` comment).
 *
 * ─── Why a formal machine? ───────────────────────────────────────────────
 *
 * Before this module existed, every feature that touched `User.status`
 * (OTP verify, admin suspend, account delete, B2B approval) re-implemented
 * its own status check. That gave us:
 *
 *   - inconsistent rules ("can a SUSPENDED user log in?" answered three
 *     different ways across the codebase)
 *   - no centralised audit trail of status changes
 *   - illegal transitions silently succeeding (e.g. reactivating a
 *     DELETED account)
 *
 * The state machine fixes all of that with a single declarative graph
 * and a single enforcement function.
 *
 * ─── How to add a new state ──────────────────────────────────────────────
 *
 *   1. Add the constant to `UserStatus` and `ZUserStatus` in
 *      `src/lib/enums.ts`. They are exported from there so the rest of
 *      the codebase (Zod parsing, admin UI dropdowns) sees the new value
 *      automatically.
 *   2. Add an entry to `TRANSITIONS` below for every legal `from → new`
 *      AND `new → to` pair. If a new state is terminal, only inbound
 *      transitions are needed.
 *   3. Update the boolean query helpers (`isLoginPermitted`, etc.) if
 *      the new state changes their answer.
 *   4. Add UNIT cases for the new state to
 *      `scripts/test-account-state-machine.ts`.
 *
 * ─── How to add a new transition ─────────────────────────────────────────
 *
 *   Add a single entry to `TRANSITIONS`. The declarative graph IS the
 *   law — the enforcement function does not need to be touched.
 *
 *   Example:
 *     TRANSITIONS.set('PENDING_OTP→PENDING_PHONE_VERIFICATION', {
 *       label:    'Email verified, now needs phone OTP',
 *       allowed:  ['SYSTEM'],
 *       activity: 'ACCOUNT_PHONE_PENDING',
 *     });
 *
 * ─── Files that must be reviewed when the graph changes ──────────────────
 *
 *   - This module (the graph itself + any helper changes)
 *   - `src/lib/enums.ts` (the enum)
 *   - `scripts/test-account-state-machine.ts` (UNIT cases)
 *   - Admin UI dropdowns/forms that list statuses
 *     (currently only `src/app/api/admin/customers/[id]/route.ts` validates
 *     status as a Zod enum — update its `.enum([...])` list if the set
 *     of admin-assignable statuses changes)
 *   - `lib/auth/session.ts` — `getCurrentUser` and any login gating
 *
 * THE TRANSITION GRAPH IS LAW. If a `(from → to)` pair is not in
 * `TRANSITIONS`, it does not happen.
 */
import { prisma } from '@/lib/db/client';
import { UserStatus, type UserStatus as UserStatusT } from '@/lib/enums';
import { revokeAllSessions } from '@/lib/auth/session';
import { log } from '@/lib/log';
import { InternalError } from '@/lib/errors';
import type { User } from '@prisma/client';
// Pure helpers live in a sibling file to avoid the import cycle
// `session.ts → accountStateMachine.ts → session.ts` that would
// otherwise occur if `session.ts` used these helpers AND
// `accountStateMachine.ts` used `revokeAllSessions`. See
// `accountStateHelpers.ts` for the full rationale.
import {
  isLoginPermitted, isOrderPermitted, isWritePermitted,
  isTerminal, isKnownStatus,
} from '@/lib/auth/accountStateHelpers';

// ── Actor context ──────────────────────────────────────────────────────────
//
// Every transition declares which actor types are permitted. The caller
// passes a tagged-union value describing WHO is initiating the change.
// Untagged or under-specified actors (e.g. `{ type: 'ADMIN' }` without an
// `adminId`) are rejected by the enforcement layer.

export type ActorContext =
  | { type: 'SYSTEM' }
  | { type: 'ADMIN'; adminId: string }
  | { type: 'SELF'; userId: string };

export type ActorType = ActorContext['type'];

// ── Transition rule shape ──────────────────────────────────────────────────

type TransitionPrecondition = (user: User) => true | { ok: false; detail: string };

interface TransitionRule {
  /** Human-readable summary — surfaced into the AuditLog `action` field. */
  label: string;
  /** Which actor types may initiate this transition. */
  allowed: ReadonlyArray<ActorType>;
  /** UserActivity.action value written for this transition. */
  activity: string;
  /** Optional extra guards beyond state + actor. Run in order. */
  preconditions?: ReadonlyArray<TransitionPrecondition>;
  /** If true, revoke every refresh family + session for the user as part
   *  of the transaction. Used for ACTIVE→SUSPENDED / ACTIVE→DELETED so a
   *  user whose cookies are still valid is logged out immediately. */
  revokeSessions?: boolean;
}

// ── Helpers for graph keys ─────────────────────────────────────────────────

type TransitionKey = `${UserStatusT}→${UserStatusT}`;
function key(from: UserStatusT, to: UserStatusT): TransitionKey {
  return `${from}→${to}`;
}

// ── Preconditions (declarative; declared up here so the graph reads
//                  as documentation) ───────────────────────────────────────

/** An admin must not delete their own account through this route. */
const PRECONDITION_NOT_SELF_TARGET =
  (actorAdminId: string | null) =>
    (user: User): true | { ok: false; detail: string } =>
      actorAdminId && actorAdminId === user.id
        ? { ok: false, detail: 'An admin cannot transition their own account through this surface.' }
        : true;

// ── THE GRAPH ──────────────────────────────────────────────────────────────
//
// Every legal transition is listed here. Anything NOT listed is rejected.
//
// Read this top-to-bottom to understand the complete account lifecycle:
//
//   PENDING_OTP ──email OTP──▶ ACTIVE ──admin suspend──▶ SUSPENDED
//        │                       │                          │
//        │                       │                          │
//        │                  admin/self                  admin
//        │                  delete                      reinstate / delete
//        │                       │                          │
//        └──admin────▶ DELETED ◀─┴──────────────────────────┘
//                       (terminal — no outbound transitions)
//
const TRANSITIONS = new Map<TransitionKey, TransitionRule>([
  // PENDING_OTP → PENDING_PHONE_VERIFICATION: email verified, awaiting
  // phone OTP. This is the FIRST hop of the new two-factor onboarding
  // (Feature: Phone Verification). The OTP-verify route fires this when
  // a SIGNUP-purpose code is consumed. SYSTEM actor — the user proved
  // possession of their email, no admin involvement.
  [key(UserStatus.PENDING_OTP, UserStatus.PENDING_PHONE_VERIFICATION), {
    label:    'Email verified — awaiting phone OTP',
    allowed:  ['SYSTEM'],
    activity: 'EMAIL_VERIFIED_PHONE_PENDING',
  }],

  // PENDING_PHONE_VERIFICATION → ACTIVE: phone OTP verified by Firebase.
  // SYSTEM actor — the user proved possession of their phone via SMS.
  [key(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.ACTIVE), {
    label:    'Phone verified — account fully active',
    allowed:  ['SYSTEM'],
    activity: 'ACCOUNT_ACTIVATED',
  }],

  // PENDING_PHONE_VERIFICATION → SUSPENDED: admin holds an account that
  // never finished phone verification (abuse / fraud signal).
  [key(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.SUSPENDED), {
    label:    'Admin suspends a phone-pending account',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_SUSPENDED',
    revokeSessions: true,
  }],

  // PENDING_PHONE_VERIFICATION → DELETED: admin removes an account that
  // never finished phone verification.
  [key(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.DELETED), {
    label:    'Admin deletes a phone-pending account',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_DELETED',
    revokeSessions: true,
  }],

  // ACTIVE → PENDING_PHONE_VERIFICATION: the user updated their phone
  // number, so we force re-verification. SYSTEM actor — fired by the
  // `PATCH /api/account/phone` route after the new number is stored.
  // The route also revokes all refresh families (separate concern).
  [key(UserStatus.ACTIVE, UserStatus.PENDING_PHONE_VERIFICATION), {
    label:    'User changed phone — re-verification required',
    allowed:  ['SYSTEM'],
    activity: 'PHONE_REVERIFICATION_REQUIRED',
  }],

  // PENDING_OTP → ACTIVE: legacy single-step path retained so the existing
  // graph + tests still treat it as a known (currently dormant) entry.
  // Production code now hops through PENDING_PHONE_VERIFICATION; we keep
  // this rule so historical migrations / admin overrides still work if a
  // user-row sits in PENDING_OTP without any phone (no longer reachable
  // from signup but a defensive option).
  [key(UserStatus.PENDING_OTP, UserStatus.ACTIVE), {
    label:    'Activate account on successful email OTP (legacy 1-step)',
    allowed:  ['SYSTEM'],
    activity: 'ACCOUNT_ACTIVATED',
  }],

  // PENDING_OTP → DELETED: an admin clears stale never-verified accounts.
  // No session revocation needed because PENDING_OTP cannot log in.
  [key(UserStatus.PENDING_OTP, UserStatus.DELETED), {
    label:    'Admin removes a pending-OTP account that never verified',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_DELETED',
  }],

  // ACTIVE → SUSPENDED: admin-imposed hold. The user can still log in to
  // VIEW their account (we honour `isLoginPermitted(SUSPENDED) === false`
  // below — see the FAQ in the helpers section for why we still revoke
  // the session here). We always revoke refresh families so a user whose
  // access token is still valid is logged out immediately.
  [key(UserStatus.ACTIVE, UserStatus.SUSPENDED), {
    label:    'Admin suspends an active account',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_SUSPENDED',
    revokeSessions: true,
  }],

  // ACTIVE → DELETED: admin removes (or future: user self-deletes).
  // Refresh families are always killed. Note the precondition: an admin
  // cannot delete their own account via this surface — they must use a
  // dedicated "transfer ownership + delete" flow (out of scope for this
  // feature; the precondition just guards against accidental click-of-doom).
  [key(UserStatus.ACTIVE, UserStatus.DELETED), {
    label:    'Account deleted (admin or user-initiated)',
    allowed:  ['ADMIN', 'SELF'],
    activity: 'ACCOUNT_DELETED',
    revokeSessions: true,
  }],

  // SUSPENDED → ACTIVE: admin reinstates. The user must log back in
  // (their refresh family was killed during the suspend); we do not
  // restore any session.
  [key(UserStatus.SUSPENDED, UserStatus.ACTIVE), {
    label:    'Admin reinstates a suspended account',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_REINSTATED',
  }],

  // SUSPENDED → DELETED: admin escalates a suspension to permanent removal.
  [key(UserStatus.SUSPENDED, UserStatus.DELETED), {
    label:    'Admin deletes a suspended account',
    allowed:  ['ADMIN'],
    activity: 'ACCOUNT_DELETED',
  }],

  // DELETED is TERMINAL. No outbound transitions. The enforcement layer
  // ALSO carries a hard guard for this case so a future graph-edit mistake
  // can't accidentally make DELETED reversible.
]);

// ── Public query helpers (pure, no DB) ─────────────────────────────────────
//
// Re-exported from `accountStateHelpers.ts` so day-to-day callers can
// import everything from one module. The split exists ONLY to break the
// `session.ts ↔ accountStateMachine.ts` import cycle described in the
// header of `accountStateHelpers.ts`.
export {
  isLoginPermitted, isOrderPermitted, isWritePermitted,
  isTerminal, isKnownStatus,
} from '@/lib/auth/accountStateHelpers';

/**
 * Pure predicate — would a transition be ALLOWED if attempted right now?
 * Used for UI gating, pre-flight checks, and unit tests. Does not consult
 * the DB; does not run preconditions (those need a `User` row).
 */
export function canTransition(
  from: string,
  to: string,
  actor: ActorContext,
): boolean {
  // Hard terminal guard — DELETED is irreversible regardless of graph.
  if (from === UserStatus.DELETED) return false;
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  if (from === to) return false;
  const rule = TRANSITIONS.get(key(from, to));
  if (!rule) return false;
  if (!rule.allowed.includes(actor.type)) return false;
  // Reject `{ type: 'ADMIN' }` without an adminId — the type system enforces
  // this at compile time, but a misuse via `as ActorContext` would slip
  // past — defence in depth.
  if (actor.type === 'ADMIN' && !actor.adminId) return false;
  if (actor.type === 'SELF'  && !actor.userId)  return false;
  return true;
}

// ── Result shape ───────────────────────────────────────────────────────────

export type TransitionFailureReason =
  | 'ILLEGAL_TRANSITION'
  | 'ACTOR_NOT_PERMITTED'
  | 'PRECONDITION_FAILED'
  | 'USER_NOT_FOUND'
  | 'CONCURRENT_MODIFICATION';

export type TransitionResult =
  | { ok: true;  user: User }
  | {
      ok: false;
      reason: TransitionFailureReason;
      /** Echoed for log correlation. */
      from?: string;
      to?: string;
      actor?: ActorType;
      detail?: string;
    };

// ── Options + internal types ───────────────────────────────────────────────

export interface TransitionOptions {
  /** Optional human-readable reason — surfaced into the AuditLog payload. */
  reason?: string;
}

// ── The enforcement function — the ONLY way to mutate User.status ──────────
//
// Anything else is a defect.

export async function transitionAccountState(
  userId: string,
  targetStatus: UserStatusT,
  actor: ActorContext,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  // Step 1: read current user (only the fields we need).
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, role: true, email: true },
  });
  if (!user) {
    log.warn('account.state.transition.rejected', {
      userId, to: targetStatus, actor: actor.type, reason: 'USER_NOT_FOUND',
    });
    return { ok: false, reason: 'USER_NOT_FOUND', to: targetStatus, actor: actor.type };
  }

  const currentStatus = user.status;

  // Step 2: validate current status is known. An unknown value in the DB
  // means data corruption (manual SQL edit, failed migration); we refuse
  // to apply a transition from a state we don't understand.
  if (!isKnownStatus(currentStatus)) {
    log.error('account.state.corrupted', { userId, statusInDb: currentStatus });
    // Typed InternalError so handleError maps to a 500 + safe client
    // message — never leak the corrupted status value in the response.
    throw new InternalError(
      `Account state corrupted: User ${userId} has unknown status "${currentStatus}".`,
      {
        code: 'ACCOUNT_STATE_CORRUPTED',
        clientMessage: 'Your account is in an inconsistent state. Please contact support.',
        context: { userId, statusInDb: currentStatus },
      },
    );
  }

  // Step 3: hard terminal guard — DELETED is forever, regardless of graph.
  if (currentStatus === UserStatus.DELETED) {
    log.warn('account.state.transition.rejected', {
      userId, from: currentStatus, to: targetStatus, actor: actor.type,
      reason: 'ILLEGAL_TRANSITION', detail: 'DELETED is terminal',
    });
    return {
      ok: false, reason: 'ILLEGAL_TRANSITION',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: 'DELETED is a terminal state.',
    };
  }

  // Step 4: validate target status is known.
  if (!isKnownStatus(targetStatus)) {
    log.warn('account.state.transition.rejected', {
      userId, from: currentStatus, to: targetStatus, actor: actor.type,
      reason: 'ILLEGAL_TRANSITION', detail: 'Unknown target status',
    });
    return {
      ok: false, reason: 'ILLEGAL_TRANSITION',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: `"${targetStatus}" is not a known UserStatus.`,
    };
  }

  // Step 5: no-op transitions are illegal — callers must check first.
  if (currentStatus === targetStatus) {
    return {
      ok: false, reason: 'ILLEGAL_TRANSITION',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: 'No-op transition (current === target).',
    };
  }

  // Step 6: look up the rule.
  const rule = TRANSITIONS.get(key(currentStatus as UserStatusT, targetStatus));
  if (!rule) {
    log.warn('account.state.transition.rejected', {
      userId, from: currentStatus, to: targetStatus, actor: actor.type,
      reason: 'ILLEGAL_TRANSITION',
    });
    return {
      ok: false, reason: 'ILLEGAL_TRANSITION',
      from: currentStatus, to: targetStatus, actor: actor.type,
    };
  }

  // Step 7: validate actor.
  if (!rule.allowed.includes(actor.type)) {
    log.warn('account.state.transition.rejected', {
      userId, from: currentStatus, to: targetStatus, actor: actor.type,
      reason: 'ACTOR_NOT_PERMITTED',
    });
    return {
      ok: false, reason: 'ACTOR_NOT_PERMITTED',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: `Actor "${actor.type}" cannot transition ${currentStatus} → ${targetStatus}. Allowed: ${rule.allowed.join(', ')}.`,
    };
  }
  // Defence-in-depth: an `as ActorContext` cast could land us with an
  // ADMIN actor missing an adminId. Reject explicitly.
  if (actor.type === 'ADMIN' && !actor.adminId) {
    return {
      ok: false, reason: 'ACTOR_NOT_PERMITTED',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: 'ADMIN actor must carry an adminId.',
    };
  }
  if (actor.type === 'SELF' && !actor.userId) {
    return {
      ok: false, reason: 'ACTOR_NOT_PERMITTED',
      from: currentStatus, to: targetStatus, actor: actor.type,
      detail: 'SELF actor must carry a userId.',
    };
  }

  // Step 8: load the full row (needed for precondition checks + before/after
  // audit payload). We did a thin SELECT first to fail fast; now go wide.
  const fullUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!fullUser) {
    return { ok: false, reason: 'USER_NOT_FOUND', to: targetStatus, actor: actor.type };
  }

  // Step 9: run preconditions.
  const checks: TransitionPrecondition[] = [];
  if (rule.preconditions) checks.push(...rule.preconditions);
  // Built-in self-target guard for ADMIN: never let an admin transition
  // their OWN account through this surface (delete-self should go through
  // a dedicated, more deliberate flow).
  if (actor.type === 'ADMIN') {
    checks.push(PRECONDITION_NOT_SELF_TARGET(actor.adminId));
  }
  for (const check of checks) {
    const r = check(fullUser);
    if (r !== true) {
      log.warn('account.state.transition.rejected', {
        userId, from: currentStatus, to: targetStatus, actor: actor.type,
        reason: 'PRECONDITION_FAILED', detail: r.detail,
      });
      return {
        ok: false, reason: 'PRECONDITION_FAILED',
        from: currentStatus, to: targetStatus, actor: actor.type,
        detail: r.detail,
      };
    }
  }

  // Step 10: apply within a transaction. We re-read INSIDE the transaction
  // so a concurrent transition between steps 1 and 10 is detected and
  // rejected — `prisma.user.update` with the where-clause on status acts
  // as an optimistic lock.
  const before = { status: currentStatus };
  const after  = { status: targetStatus, reason: options.reason ?? null };

  let updated: User;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // Optimistic-concurrency guard: only update if status is still
      // `currentStatus`. Prisma throws P2025 if the row doesn't match.
      const u = await tx.user.update({
        where: { id: userId, status: currentStatus },
        data:  { status: targetStatus },
      });

      // Always-on UserActivity row (user's own history surface).
      await tx.userActivity.create({
        data: {
          userId,
          action: rule.activity,
          metadata: JSON.stringify({
            from: currentStatus,
            to: targetStatus,
            actor: actor.type,
            actorId: actor.type === 'ADMIN' ? actor.adminId : (actor.type === 'SELF' ? actor.userId : null),
            reason: options.reason ?? null,
          }),
        },
      });

      // AuditLog row — written ONLY when an admin acted. AuditLog.actorId
      // is a non-null FK to User; SYSTEM transitions have no actor row to
      // reference, so we record them on UserActivity only.
      if (actor.type === 'ADMIN') {
        await tx.auditLog.create({
          data: {
            actorId:  actor.adminId,
            action:   `ACCOUNT_STATE_TRANSITION:${rule.label}`,
            entity:   'User',
            entityId: userId,
            before:   JSON.stringify(before),
            after:    JSON.stringify(after),
          },
        });
      }
      return u;
    });
  } catch (e) {
    // Prisma P2025 — "An operation failed because it depends on one or more
    // records that were required but not found." Triggered by our optimistic-
    // lock `where: { id, status: currentStatus }` if the row's status changed
    // between steps 1 and 10. Translate to CONCURRENT_MODIFICATION.
    const code = (e as { code?: string }).code;
    if (code === 'P2025') {
      log.warn('account.state.transition.rejected', {
        userId, from: currentStatus, to: targetStatus, actor: actor.type,
        reason: 'CONCURRENT_MODIFICATION',
      });
      return {
        ok: false, reason: 'CONCURRENT_MODIFICATION',
        from: currentStatus, to: targetStatus, actor: actor.type,
        detail: 'Account status changed between read and write — please retry.',
      };
    }
    throw e;
  }

  // Step 11: side effects that must run AFTER the transaction commits.
  //
  // Refresh-family revocation lives outside the main transaction because
  // `revokeAllSessions` opens its own short-lived writes — keeping it
  // inside would lengthen the User-row lock window. It's also acceptable
  // to run after the commit: even if revocation fails, the status change
  // is durable, and the next access-token expiry (≤15 min) will eject
  // the session anyway. We still log on revocation failure so ops can
  // investigate.
  if (rule.revokeSessions) {
    try {
      await revokeAllSessions(userId);
    } catch (e) {
      log.warn('account.state.transition.revoke_failed', {
        userId, err: (e as Error).message,
      });
    }
  }

  log.info('account.state.transition', {
    userId,
    from: currentStatus,
    to: targetStatus,
    actor: actor.type,
    ok: true,
  });

  return { ok: true, user: updated };
}

// ── Convenience accessor for tests / introspection ─────────────────────────
//
// Exposed so the test suite can iterate every entry without forking the
// data structure. NOT a public API for runtime callers — those should use
// `canTransition` instead.
export function _internalTransitionEntries(): ReadonlyArray<{
  from: UserStatusT; to: UserStatusT; rule: TransitionRule;
}> {
  const out: { from: UserStatusT; to: UserStatusT; rule: TransitionRule }[] = [];
  for (const [k, rule] of TRANSITIONS.entries()) {
    const [from, to] = k.split('→') as [UserStatusT, UserStatusT];
    out.push({ from, to, rule });
  }
  return out;
}

/** Re-exported so callers can `import { UserStatus } from '@/lib/auth/accountStateMachine'`
 *  without reaching into enums.ts directly. */
export { UserStatus } from '@/lib/enums';
export type { UserStatus as UserStatusType } from '@/lib/enums';
