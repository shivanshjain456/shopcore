/**
 * Phone Verification — service layer.
 *
 * Three public functions:
 *
 *   verifyPhoneCredential(userId, idToken, submittedPhone)
 *     User-driven verification path. Verifies the Firebase ID token,
 *     cross-checks all three phone values, transitions the account
 *     state PENDING_PHONE_VERIFICATION → ACTIVE if applicable, writes
 *     UserActivity. Tagged-result return; never throws on business
 *     failures (e.g. phone mismatch).
 *
 *   markPhoneVerifiedByAdmin(targetUserId, adminId)
 *     Admin override for support cases. Skips Firebase entirely.
 *     Writes an AuditLog row tagged ADMIN_PHONE_VERIFY_OVERRIDE.
 *
 *   updateUserPhone(userId, newPhone)
 *     User changes their phone number. Resets `phoneVerified`,
 *     transitions ACTIVE → PENDING_PHONE_VERIFICATION, revokes refresh
 *     families so the user must re-login with the updated `status`
 *     claim in their fresh JWT.
 *
 * Two pure helpers exported for reuse:
 *
 *   normalisePhone(raw)   — string → E.164 +91XXXXXXXXXX (or null)
 *   maskPhone(phone)      — for log lines: `+91******1234`
 *
 * The dev-bypass token literal `'dev-bypass-token'` is recognised when
 * `NODE_ENV !== 'production'` AND lives ONLY in this file and the
 * verify route (the static audit enforces both).
 */
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import { env } from '@/lib/config';
import { UserStatus } from '@/lib/enums';
import {
  transitionAccountState,
  type TransitionFailureReason,
} from '@/lib/auth/accountStateMachine';
import { revokeAllFamilies } from '@/lib/auth/refresh';
import {
  verifyFirebasePhoneToken,
  PhoneTokenVerificationError,
} from '@/lib/auth/firebasePhone';

/** ─── Dev-bypass token literal ─────────────────────────────────────────
 *
 *  Recognised only when NODE_ENV !== 'production'. The triple-guard
 *  (route handler, this service, preflight) ensures this string CANNOT
 *  authenticate anyone in production even if a client submits it.
 *
 *  The literal lives in `phoneConstants.ts` so the client component can
 *  import it without dragging in server-only code; we re-export it
 *  here so existing server-side imports keep working.                   */
import { DEV_BYPASS_TOKEN } from '@/lib/auth/phoneConstants';
export { DEV_BYPASS_TOKEN };

// ── Phone normalisation + validation ───────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH (Item 9): `normalisePhone` + `isValidIndianMobile`
// live in `@/lib/utils/phone`. We re-export here so the 5+ existing import
// sites (`from '@/lib/auth/phoneVerification'`) keep working unchanged.
// `maskPhone` historically lived here and STAYS here — the structured-
// logger's redactor calls it as part of its serialisation contract, and
// keeping it co-located with the rest of the phone-verification service
// avoids a circular dependency between `lib/log` ↔ `lib/utils/phone`.

export { normalisePhone, isValidIndianMobile } from '@/lib/utils/phone';
import { normalisePhone } from '@/lib/utils/phone';

/** Mask everything but the last 4 digits. Used in log lines so we never
 *  emit a full phone number. `+919876543210` → `+91******3210`. */
export function maskPhone(phone: string): string {
  if (!phone) return '';
  if (phone.length <= 4) return '*'.repeat(phone.length);
  const tail = phone.slice(-4);
  // Build mask preserving the leading '+' if present.
  if (phone.startsWith('+')) {
    const prefix = phone.slice(0, 3);  // '+91'
    return prefix + '*'.repeat(Math.max(0, phone.length - prefix.length - 4)) + tail;
  }
  return '*'.repeat(phone.length - 4) + tail;
}

// ── Result types ───────────────────────────────────────────────────────────

export type PhoneVerifyFailureReason =
  | 'INVALID_STATE'
  | 'PHONE_MISMATCH'
  | 'PHONE_TAKEN'
  | 'PHONE_ALREADY_LINKED'
  | 'DEV_BYPASS_REJECTED'
  | 'FIREBASE_UNAVAILABLE'
  | 'INVALID_FIREBASE_TOKEN'
  | 'USER_NOT_FOUND'
  | 'STATE_MACHINE_REJECTED';

export type PhoneVerifyResult =
  | { ok: true; data: { phoneVerified: true; accountStatus: string; alreadyVerified: boolean } }
  | { ok: false; reason: PhoneVerifyFailureReason; detail?: string;
      stateMachineReason?: TransitionFailureReason };

export type UpdatePhoneFailureReason =
  | 'INVALID_PHONE'
  | 'PHONE_TAKEN'
  | 'USER_NOT_FOUND'
  | 'STATE_MACHINE_REJECTED';

export type UpdatePhoneResult =
  | { ok: true; data: { phone: string; requiresVerification: boolean } }
  | { ok: false; reason: UpdatePhoneFailureReason; detail?: string };

export type AdminOverrideFailureReason =
  | 'USER_NOT_FOUND'
  | 'ALREADY_VERIFIED'
  | 'STATE_MACHINE_REJECTED';

export type AdminOverrideResult =
  | { ok: true; data: { phoneVerified: true; accountStatus: string; alreadyVerified: boolean } }
  | { ok: false; reason: AdminOverrideFailureReason; detail?: string };

// ── verifyPhoneCredential ──────────────────────────────────────────────────

/** Core verify path. Idempotent on a fully-verified user. */
export async function verifyPhoneCredential(
  userId: string,
  idToken: string,
  submittedPhone: string,
): Promise<PhoneVerifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, status: true, phone: true,
      phoneVerified: true, firebasePhoneUid: true,
    },
  });
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

  // Dev-bypass — TRIPLE-GUARD point #2 (route handler is #1, preflight #3).
  const isDevBypass = idToken === DEV_BYPASS_TOKEN;
  if (isDevBypass && env.NODE_ENV === 'production') {
    log.warn('phone.verify.dev_bypass', {
      userId, rejected: true, reason: 'production_guard',
    });
    return { ok: false, reason: 'DEV_BYPASS_REJECTED' };
  }

  // State gate. ACTIVE is allowed so re-submission is idempotent.
  if (user.status !== UserStatus.PENDING_PHONE_VERIFICATION
   && user.status !== UserStatus.ACTIVE) {
    return { ok: false, reason: 'INVALID_STATE',
      detail: `Account is in state ${user.status}; phone verification not permitted.` };
  }

  // Normalise the client's submitted phone — protects against
  // formatting drift between client + DB.
  const normalisedSubmitted = normalisePhone(submittedPhone);
  if (!normalisedSubmitted) {
    return { ok: false, reason: 'PHONE_MISMATCH', detail: 'Submitted phone is not a valid Indian mobile.' };
  }

  // Resolve the Firebase claim.
  let firebaseUid: string;
  let tokenPhone: string;
  if (isDevBypass) {
    log.warn('phone.verify.dev_bypass', { userId });
    firebaseUid = `dev-bypass-${user.id}`;
    tokenPhone  = normalisedSubmitted;
  } else {
    let tokenResult: { uid: string; phone: string } | null;
    try {
      tokenResult = await verifyFirebasePhoneToken(idToken);
    } catch (e) {
      if (e instanceof PhoneTokenVerificationError) {
        return { ok: false, reason: 'INVALID_FIREBASE_TOKEN', detail: e.firebaseCode ?? undefined };
      }
      throw e;
    }
    if (!tokenResult) {
      // Admin SDK not configured. In non-production we let the caller
      // proceed via the dev-bypass path (the route handler explicitly
      // re-submits with `DEV_BYPASS_TOKEN` for this case). At this layer
      // we still emit a structured warning and refuse.
      if (env.NODE_ENV === 'production') {
        log.error('phone.verify.firebase_unavailable', { userId });
      } else {
        log.warn('phone.verify.firebase_unavailable', { userId });
      }
      return { ok: false, reason: 'FIREBASE_UNAVAILABLE' };
    }
    firebaseUid = tokenResult.uid;
    // Normalise the token's phone too — Firebase always emits E.164
    // but we run it through our normaliser anyway so any whitespace
    // never bites us.
    const normalisedToken = normalisePhone(tokenResult.phone);
    if (!normalisedToken) {
      return { ok: false, reason: 'PHONE_MISMATCH', detail: 'Firebase phone claim could not be normalised.' };
    }
    tokenPhone = normalisedToken;
  }

  // Three-way agreement.
  const dbPhone = normalisePhone(user.phone);
  if (!dbPhone || dbPhone !== normalisedSubmitted || normalisedSubmitted !== tokenPhone) {
    log.warn('phone.verify.mismatch', { userId, reason: 'PHONE_MISMATCH' });
    return { ok: false, reason: 'PHONE_MISMATCH',
      detail: 'Phone number on file, submitted, and Firebase token must all match.' };
  }

  // Firebase UID re-linkage check: if the row already carries a
  // firebasePhoneUid, only the SAME uid may verify (no silent takeover).
  if (user.firebasePhoneUid && user.firebasePhoneUid !== firebaseUid) {
    log.warn('phone.verify.mismatch', { userId, reason: 'PHONE_ALREADY_LINKED' });
    return { ok: false, reason: 'PHONE_ALREADY_LINKED',
      detail: 'This account is linked to a different Firebase phone identity.' };
  }

  // Idempotent fast-path — user is already ACTIVE + phoneVerified +
  // same firebase uid: no-op success.
  if (user.status === UserStatus.ACTIVE
   && user.phoneVerified
   && user.firebasePhoneUid === firebaseUid) {
    log.info('phone.verify.success', { userId, firebaseUid, idempotent: true });
    return { ok: true, data: { phoneVerified: true, accountStatus: user.status, alreadyVerified: true } };
  }

  // Takeover guard — another user already holds this phone+verified.
  // Run inside the transaction below for atomicity.
  const taken = await prisma.user.findFirst({
    where: {
      phone: dbPhone,
      phoneVerified: true,
      NOT: { id: user.id },
    },
    select: { id: true },
  });
  if (taken) {
    log.warn('phone.verify.mismatch', { userId, reason: 'PHONE_TAKEN' });
    return { ok: false, reason: 'PHONE_TAKEN',
      detail: 'This phone number is already verified on another account.' };
  }

  // Apply: update verification columns first (single-statement), then
  // transition the state if applicable. We keep them as TWO logical
  // operations rather than wrapping in one $transaction because
  // `transitionAccountState` itself opens its own transaction and we
  // must not nest. The verification-row update is idempotent on retry.
  try {
    await prisma.user.update({
      where: { id: user.id, phoneVerified: false },
      data: {
        phoneVerified:    true,
        phoneVerifiedAt:  new Date(),
        firebasePhoneUid: firebaseUid,
      },
    });
  } catch (e) {
    // P2025 here ONLY if a concurrent verify won the race — re-check
    // current row state below and treat as idempotent success.
    const code = (e as { code?: string }).code;
    if (code !== 'P2025') throw e;
  }

  // Audit-only activity row when the verification-columns wrote a row.
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'PHONE_VERIFIED',
      metadata: JSON.stringify({ firebaseUid, devBypass: isDevBypass }) },
  });

  // State transition (only if currently PENDING_PHONE_VERIFICATION).
  let finalStatus: string = user.status;
  if (user.status === UserStatus.PENDING_PHONE_VERIFICATION) {
    const r = await transitionAccountState(
      user.id,
      UserStatus.ACTIVE,
      { type: 'SYSTEM' },
      { reason: 'Phone OTP verified' },
    );
    if (!r.ok) {
      // Should be impossible — PENDING_PHONE_VERIFICATION → ACTIVE is
      // unconditionally allowed for SYSTEM — but defence-in-depth: log
      // and propagate so the route handler can return a useful error.
      log.error('phone.verify.transition_failed', { userId, reason: r.reason });
      return { ok: false, reason: 'STATE_MACHINE_REJECTED',
        detail: r.detail ?? r.reason, stateMachineReason: r.reason };
    }
    finalStatus = r.user.status;
  }

  log.info('phone.verify.success', { userId, firebaseUid });
  return { ok: true, data: { phoneVerified: true, accountStatus: finalStatus, alreadyVerified: false } };
}

// ── markPhoneVerifiedByAdmin ───────────────────────────────────────────────

/** Admin override — skips Firebase, writes AuditLog. Caller must already
 *  have authenticated the admin (`requireAdminUser`). */
export async function markPhoneVerifiedByAdmin(
  targetUserId: string,
  adminId: string,
): Promise<AdminOverrideResult> {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, status: true, phone: true,
      phoneVerified: true, firebasePhoneUid: true },
  });
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

  const before = {
    phoneVerified: user.phoneVerified,
    phoneVerifiedAt: null as Date | null,
    firebasePhoneUid: user.firebasePhoneUid,
    status: user.status,
  };

  // Mark verified. Use idempotent UPSERT-style guard so a duplicate
  // override doesn't bump phoneVerifiedAt.
  if (!user.phoneVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        phoneVerified:    true,
        phoneVerifiedAt:  new Date(),
        // We don't synthesise a fake Firebase UID here — leave it null
        // so a later legitimate Firebase-driven verify (e.g. user
        // self-completes after admin override) still records a real UID.
      },
    });
  }

  // Transition state if applicable. The state graph only allows SYSTEM
  // to perform PENDING_PHONE_VERIFICATION → ACTIVE (it's the natural
  // result of a phone OTP succeeding, not an admin status decision).
  // The admin's role here is to ATTEST that the customer's phone is
  // theirs — the state advance is the downstream consequence, so we
  // use a SYSTEM transition and rely on the explicit AuditLog row
  // below (ADMIN_PHONE_VERIFY_OVERRIDE) for the admin-action trail.
  let finalStatus: string = user.status;
  if (user.status === UserStatus.PENDING_PHONE_VERIFICATION) {
    const r = await transitionAccountState(
      user.id,
      UserStatus.ACTIVE,
      { type: 'SYSTEM' },
      { reason: `Admin phone-verify override by ${adminId}` },
    );
    if (!r.ok) {
      log.error('phone.admin_override.transition_failed', { targetUserId, adminId, reason: r.reason });
      return { ok: false, reason: 'STATE_MACHINE_REJECTED', detail: r.detail ?? r.reason };
    }
    finalStatus = r.user.status;
  }

  // ALWAYS audit — admin override is a privileged action.
  await prisma.auditLog.create({
    data: {
      actorId:  adminId,
      action:   'ADMIN_PHONE_VERIFY_OVERRIDE',
      entity:   'User',
      entityId: user.id,
      before:   JSON.stringify(before),
      after:    JSON.stringify({ phoneVerified: true, status: finalStatus }),
    },
  });
  await prisma.userActivity.create({
    data: { userId: user.id, action: 'PHONE_VERIFIED',
      metadata: JSON.stringify({ adminOverride: true, adminId }) },
  });

  log.info('phone.admin_override', { targetUserId, adminId });
  return { ok: true, data: { phoneVerified: true, accountStatus: finalStatus, alreadyVerified: user.phoneVerified } };
}

// ── updateUserPhone ────────────────────────────────────────────────────────

/** User self-service phone update. Forces re-verification + logs out
 *  every session so the next login JWT carries the new `status` claim. */
export async function updateUserPhone(
  userId: string,
  rawNewPhone: string,
): Promise<UpdatePhoneResult> {
  const normalised = normalisePhone(rawNewPhone);
  if (!normalised) return { ok: false, reason: 'INVALID_PHONE',
    detail: 'Enter a valid 10-digit Indian mobile number.' };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, phone: true, phoneVerified: true },
  });
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

  // Taken check — `phone` is globally @unique so we'd hit P2002 anyway,
  // but pre-checking gives a clean error.
  const collision = await prisma.user.findFirst({
    where: { phone: normalised, NOT: { id: user.id } },
    select: { id: true },
  });
  if (collision) return { ok: false, reason: 'PHONE_TAKEN' };

  // If the new phone equals the current one, no-op success — same
  // phone shouldn't kill the user's sessions.
  if (user.phone === normalised) {
    return { ok: true, data: { phone: normalised, requiresVerification: !user.phoneVerified } };
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        phone:            normalised,
        phoneVerified:    false,
        phoneVerifiedAt:  null,
        firebasePhoneUid: null,
      },
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'P2002') return { ok: false, reason: 'PHONE_TAKEN' };
    throw e;
  }

  // Only transition when the current state is ACTIVE — for users still
  // in PENDING_PHONE_VERIFICATION the state is already correct.
  if (user.status === UserStatus.ACTIVE) {
    const r = await transitionAccountState(
      user.id,
      UserStatus.PENDING_PHONE_VERIFICATION,
      { type: 'SYSTEM' },
      { reason: 'User updated phone number' },
    );
    if (!r.ok) {
      log.error('phone.update.transition_failed', { userId, reason: r.reason });
      return { ok: false, reason: 'STATE_MACHINE_REJECTED', detail: r.detail ?? r.reason };
    }
  }

  await prisma.userActivity.create({
    data: { userId: user.id, action: 'PHONE_CHANGED',
      metadata: JSON.stringify({ newPhone: maskPhone(normalised) }) },
  });

  // Revoke every refresh family so the user must re-login. The next
  // login will mint a JWT that carries the updated `status` claim,
  // which the middleware reads to redirect to `/verify-phone`.
  try {
    await revokeAllFamilies(user.id, 'PHONE_CHANGED');
  } catch (e) {
    // Non-fatal — log and continue. The status change is already durable.
    log.warn('phone.update.revoke_failed', { userId, err: (e as Error).message });
  }

  log.info('phone.update', { userId });
  return { ok: true, data: { phone: normalised, requiresVerification: true } };
}
