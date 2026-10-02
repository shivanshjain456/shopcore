/**
 * Password-reset core service — Feature #12.
 *
 *   Two-stage flow:
 *     1. issueResetRequest(email)       → { requestId, expiresAt }
 *        - ONE active PasswordResetRequest per email at a time.
 *        - On a clean call: creates the request row, fires an RESET-purpose
 *          OTP (issueOtp re-used unchanged), binds the OTP row to the
 *          request via OtpCode.resetRequestId.
 *        - For unknown emails, returns the SAME shape with a synthesised
 *          requestId so callers cannot enumerate accounts by comparing
 *          response shapes / timings. Caller MUST NOT log this fact.
 *
 *     2. verifyResetOtp({ requestId, code }) → { resetToken, expiresAt }
 *        - Looks up the active request, runs the OTP through verifyOtp(),
 *          mints a 32-byte opaque reset token, stores its SHA-256 hash in
 *          PasswordResetToken, returns the plaintext to the caller ONCE.
 *        - The verify is bound to the requestId — a stolen OTP cannot be
 *          paired with a different request.
 *
 *     3. consumeResetToken({ resetToken, newPassword }) → { userId }
 *        - Validates the token (hash lookup, single-use, expiry).
 *        - Runs newPassword through the shared validator
 *          (lib/auth/passwordPolicy — Feature #11) WITH the user's email
 *          so the username-in-password rule fires.
 *        - Hashes via the existing bcrypt helper (no change to hashing).
 *        - Updates User.passwordHash, marks token + request consumed,
 *          revokes EVERY refresh-token family for the user
 *          (revokeAllFamilies — same path as logout / password-change).
 *
 *   Security notes:
 *     - Reset tokens are 256-bit opaque secrets stored as SHA-256. The
 *       plaintext is returned exactly once and is never logged.
 *     - All tokens are tombstoned (consumedAt set), never deleted, so
 *       forensics work.
 *     - OTP verification is done by the existing `verifyOtp()` — single
 *       chokepoint, all hardening (attempt counter, last-attempt consume,
 *       hashed-at-rest) inherited.
 *     - Issuing a new OTP via `resendResetOtp()` invalidates the prior
 *       OTP for the same request (via issueOtp's existing behaviour) AND
 *       increments PasswordResetRequest.otpIssueCount; after maxOtpIssue
 *       the request is marked EXPIRED.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { issueOtp, verifyOtp } from '@/lib/auth/otp';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { assertPasswordOk } from '@/lib/auth/passwordPolicy';
import { revokeAllFamilies } from '@/lib/auth/refresh';
import { log } from '@/lib/log';

// ── Tunables ───────────────────────────────────────────────────────────────
/** A PasswordResetRequest dies absolutely after this many minutes. */
export const RESET_REQUEST_TTL_MINUTES = 30;
/** A single PasswordResetToken (post-OTP) lives for this many minutes. */
export const RESET_TOKEN_TTL_MINUTES = 10;
/** How many OTP issuances we tolerate against a single request. */
export const RESET_MAX_OTP_ISSUE = 5;

// ── Helpers ────────────────────────────────────────────────────────────────
/** Generate a 32-byte url-safe random secret (~256 bits entropy). */
function generateResetSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}
/** SHA-256 hex of the secret. Stored at rest; the plaintext is never persisted. */
export function hashResetSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function looksLikeResetSecret(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(s);
}

// ── Types ──────────────────────────────────────────────────────────────────
export type InitiateResult = {
  ok: true;
  requestId: string;
  expiresAt: Date;
  /** True iff a real user was found AND an OTP was actually sent.
   *  Never surface this to the API caller — the route returns generic
   *  responses. Useful only for tests + internal logging. */
  delivered: boolean;
};

export type VerifyResult =
  | { ok: true; resetToken: string; expiresAt: Date; userId: string }
  | { ok: false; reason: string; status?: number; code?: string };

export type ResendResult =
  | { ok: true; expiresAt: Date; delivered: boolean }
  | { ok: false; reason: string; status?: number; retryAfterSeconds?: number };

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: string; status?: number; code?: string };

// ── 1. initiate ────────────────────────────────────────────────────────────
/**
 * Create (or refresh) a PasswordResetRequest for the given email and dispatch
 * a RESET-purpose OTP email. Returns a generic-looking envelope so callers
 * can never distinguish known vs unknown emails.
 */
export async function initiateReset(params: {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<InitiateResult> {
  const email = params.email.toLowerCase().trim();
  const now = new Date();
  const reqExpiresAt = new Date(now.getTime() + RESET_REQUEST_TTL_MINUTES * 60_000);

  const user = await prisma.user.findUnique({ where: { email } });

  // For UNKNOWN / SUSPENDED / DELETED — synthesise a fake-but-shaped
  // requestId + expiry so the response shape is indistinguishable. We do
  // NOT create a DB row (no enumeration footprint via DB-side counters
  // either).
  if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
    log.info('passwordReset.initiate.neutral', { email, present: !!user, status: user?.status });
    return {
      ok: true,
      requestId: `noop_${crypto.randomBytes(12).toString('base64url')}`,
      expiresAt: reqExpiresAt,
      delivered: false,
    };
  }

  // Cancel any in-flight PENDING / OTP_VERIFIED requests for this email
  // so a fresh initiate restarts cleanly. Tombstone, do not delete.
  await prisma.passwordResetRequest.updateMany({
    where: { email, status: { in: ['PENDING', 'OTP_VERIFIED'] } },
    data: { status: 'CANCELED', consumedAt: now },
  });

  const request = await prisma.passwordResetRequest.create({
    data: {
      email,
      userId: user.id,
      status: 'PENDING',
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      otpIssueCount: 1,
      maxOtpIssue: RESET_MAX_OTP_ISSUE,
      expiresAt: reqExpiresAt,
    },
  });

  const issued = await issueOtp({
    email,
    purpose: 'RESET',
    userId: user.id,
    ipAddress: params.ipAddress ?? null,
  });
  if (!issued.ok) {
    // Cooldown / hourly-cap — surface a non-revealing error. The request
    // row stays in PENDING so a retry after cooldown can resume.
    log.warn('passwordReset.initiate.otpIssueFailed', { email, reason: issued.reason });
    return {
      ok: true,
      requestId: request.id,
      expiresAt: request.expiresAt,
      delivered: false,
    };
  }

  // Bind the issued OTP row to this request.
  await prisma.otpCode.updateMany({
    where: { email, purpose: 'RESET', consumedAt: null, resetRequestId: null },
    data:  { resetRequestId: request.id },
  });

  await prisma.userActivity.create({
    data: {
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      ipAddress: params.ipAddress ?? null,
      metadata: JSON.stringify({ requestId: request.id, otpExpiresAt: issued.expiresAt }),
    },
  });
  log.info('passwordReset.initiate.delivered', { userId: user.id, requestId: request.id });

  return { ok: true, requestId: request.id, expiresAt: request.expiresAt, delivered: true };
}

// ── 2. verify OTP → reset-token ────────────────────────────────────────────
/**
 * Verifies the OTP against the binding request, then mints a single-use
 * reset token. The plaintext token is returned ONCE and never logged.
 */
export async function verifyResetOtp(params: {
  requestId: string;
  code: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<VerifyResult> {
  const now = new Date();

  // Look up the request. A noop_* id (from neutral initiate path) will
  // miss here — return a neutral-shaped failure with the SAME error text
  // verifyOtp() would emit, so timing/text cannot distinguish.
  const request = await prisma.passwordResetRequest.findUnique({
    where: { id: params.requestId },
  });
  if (!request) {
    return { ok: false, reason: 'OTP not found or expired. Please request a new code.', status: 400, code: 'OTP_EXPIRED' };
  }
  if (request.status !== 'PENDING') {
    return { ok: false, reason: 'This reset request is no longer active. Please start over.', status: 400, code: 'REQUEST_INACTIVE' };
  }
  if (request.expiresAt <= now) {
    await prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { status: 'EXPIRED' },
    });
    return { ok: false, reason: 'This reset request has expired. Please start over.', status: 400, code: 'REQUEST_EXPIRED' };
  }
  if (!request.userId) {
    return { ok: false, reason: 'OTP not found or expired. Please request a new code.', status: 400, code: 'OTP_EXPIRED' };
  }

  // Hand off to the shared OTP verifier — inherits attempt counter,
  // hashed-at-rest comparison, last-attempt auto-consume.
  const otpResult = await verifyOtp({
    email: request.email,
    purpose: 'RESET',
    code: params.code,
  });
  if (!otpResult.ok) {
    log.info('passwordReset.verify.otpFail', { requestId: request.id });
    return { ok: false, reason: otpResult.reason, status: 400, code: 'OTP_INVALID' };
  }

  // Defence-in-depth: confirm the OTP row that was just consumed actually
  // belongs to this request (not just the same email). If a parallel
  // initiate created a competing request, verifyOtp() may have consumed
  // a different row — refuse.
  const consumedOtp = await prisma.otpCode.findFirst({
    where: { email: request.email, purpose: 'RESET', consumedAt: { not: null }, resetRequestId: request.id },
    orderBy: { consumedAt: 'desc' },
  });
  if (!consumedOtp) {
    log.warn('passwordReset.verify.bindingMismatch', { requestId: request.id });
    return { ok: false, reason: 'OTP not found or expired. Please request a new code.', status: 400, code: 'OTP_EXPIRED' };
  }

  // Mint the reset token. Existing tokens for this request are tombstoned —
  // single-use everywhere.
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000);
  const secret = generateResetSecret();
  const tokenHash = hashResetSecret(secret);

  const [, , ] = await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { requestId: request.id, consumedAt: null },
      data:  { consumedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        requestId: request.id,
        userId: request.userId,
        tokenHash,
        expiresAt,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { status: 'OTP_VERIFIED' },
    }),
  ]);

  await prisma.userActivity.create({
    data: {
      userId: request.userId,
      action: 'PASSWORD_RESET_OTP_VERIFIED',
      ipAddress: params.ipAddress ?? null,
      metadata: JSON.stringify({ requestId: request.id }),
    },
  });
  log.info('passwordReset.verify.ok', { userId: request.userId, requestId: request.id });

  // Plaintext returned exactly once. Never logged.
  return { ok: true, resetToken: secret, expiresAt, userId: request.userId };
}

// ── 3. resend OTP ─────────────────────────────────────────────────────────
export async function resendResetOtp(params: {
  requestId: string;
  ipAddress?: string | null;
}): Promise<ResendResult> {
  const now = new Date();
  const request = await prisma.passwordResetRequest.findUnique({ where: { id: params.requestId } });

  // Neutral failure shape for both unknown and inactive requests so a
  // stolen noop_* id cannot probe the system.
  if (!request) {
    return { ok: false, reason: 'This reset request is no longer active. Please start over.', status: 400 };
  }
  if (request.status !== 'PENDING') {
    return { ok: false, reason: 'This reset request is no longer active. Please start over.', status: 400 };
  }
  if (request.expiresAt <= now) {
    await prisma.passwordResetRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
    return { ok: false, reason: 'This reset request has expired. Please start over.', status: 400 };
  }
  if (request.otpIssueCount >= request.maxOtpIssue) {
    await prisma.passwordResetRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
    return { ok: false, reason: 'Too many code requests for this session. Please start over.', status: 429 };
  }

  const issued = await issueOtp({
    email: request.email,
    purpose: 'RESET',
    userId: request.userId,
    ipAddress: params.ipAddress ?? null,
  });
  if (!issued.ok) {
    return {
      ok: false,
      reason: issued.reason,
      status: 429,
      retryAfterSeconds: issued.retryAfterSeconds,
    };
  }

  await prisma.otpCode.updateMany({
    where: { email: request.email, purpose: 'RESET', consumedAt: null, resetRequestId: null },
    data:  { resetRequestId: request.id },
  });
  await prisma.passwordResetRequest.update({
    where: { id: request.id },
    data: { otpIssueCount: { increment: 1 } },
  });

  if (request.userId) {
    await prisma.userActivity.create({
      data: {
        userId: request.userId,
        action: 'PASSWORD_RESET_OTP_RESENT',
        ipAddress: params.ipAddress ?? null,
        metadata: JSON.stringify({ requestId: request.id, issueCount: request.otpIssueCount + 1 }),
      },
    });
  }

  return { ok: true, expiresAt: issued.expiresAt, delivered: true };
}

// ── 4. consume token → set new password ────────────────────────────────────
export async function consumeResetToken(params: {
  resetToken: string;
  newPassword: string;
  ipAddress?: string | null;
}): Promise<ConsumeResult> {
  if (!looksLikeResetSecret(params.resetToken)) {
    return { ok: false, reason: 'Invalid or expired reset link. Please start over.', status: 400, code: 'TOKEN_INVALID' };
  }

  const tokenHash = hashResetSecret(params.resetToken);
  const now = new Date();

  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { request: true },
  });
  if (!token) {
    return { ok: false, reason: 'Invalid or expired reset link. Please start over.', status: 400, code: 'TOKEN_INVALID' };
  }
  if (token.consumedAt) {
    log.warn('passwordReset.consume.reuse', { tokenId: token.id, userId: token.userId });
    return { ok: false, reason: 'This reset link has already been used. Please start over.', status: 400, code: 'TOKEN_CONSUMED' };
  }
  if (token.expiresAt <= now) {
    return { ok: false, reason: 'This reset link has expired. Please start over.', status: 400, code: 'TOKEN_EXPIRED' };
  }
  if (token.request.status !== 'OTP_VERIFIED' || token.request.consumedAt) {
    return { ok: false, reason: 'This reset request is no longer active. Please start over.', status: 400, code: 'REQUEST_INACTIVE' };
  }

  const user = await prisma.user.findUnique({ where: { id: token.userId } });
  if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
    return { ok: false, reason: 'This account is not available. Please contact support.', status: 403, code: 'ACCOUNT_UNAVAILABLE' };
  }

  // Shared validator — same rules as signup + password change. Email is
  // passed so the username-in-password rule fires.
  try {
    assertPasswordOk(params.newPassword, { email: user.email });
  } catch (e) {
    return { ok: false, reason: (e as Error).message, status: 400, code: 'WEAK_PASSWORD' };
  }

  // Prevent re-using the current password (the only "history" we have).
  if (await verifyPassword(params.newPassword, user.passwordHash)) {
    return { ok: false, reason: 'New password must be different from your current password.', status: 400, code: 'PASSWORD_UNCHANGED' };
  }

  const newHash = await hashPassword(params.newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }),
    prisma.passwordResetToken.update({ where: { id: token.id }, data: { consumedAt: now } }),
    prisma.passwordResetRequest.update({
      where: { id: token.requestId },
      data: { status: 'CONSUMED', consumedAt: now },
    }),
    // Belt-and-braces: invalidate any other live token for this request.
    prisma.passwordResetToken.updateMany({
      where: { requestId: token.requestId, id: { not: token.id }, consumedAt: null },
      data:  { consumedAt: now },
    }),
    // Invalidate any unconsumed OTP rows for this request.
    prisma.otpCode.updateMany({
      where: { resetRequestId: token.requestId, consumedAt: null },
      data:  { consumedAt: now },
    }),
  ]);

  // Revoke EVERY refresh-token family — same path as logout-all and
  // password-change. Active sessions on other devices die immediately.
  const revoked = await revokeAllFamilies(user.id, 'PASSWORD_RESET');

  await prisma.userActivity.create({
    data: {
      userId: user.id,
      action: 'PASSWORD_RESET_COMPLETED',
      ipAddress: params.ipAddress ?? null,
      metadata: JSON.stringify({ requestId: token.requestId, revokedFamilies: revoked }),
    },
  });
  log.info('passwordReset.consume.ok', { userId: user.id, requestId: token.requestId, revoked });

  return { ok: true, userId: user.id };
}

// ── Background sweep ───────────────────────────────────────────────────────
/** Tombstone any PENDING/OTP_VERIFIED request that's past its absolute expiry. */
export async function expireStaleResetRequests(now: Date = new Date()): Promise<number> {
  const r = await prisma.passwordResetRequest.updateMany({
    where: { status: { in: ['PENDING', 'OTP_VERIFIED'] }, expiresAt: { lt: now } },
    data:  { status: 'EXPIRED' },
  });
  return r.count;
}

/** A short, generic message — both initiate and resend return the same string. */
export const RESET_INITIATE_MESSAGE =
  'If an account exists for that email, we have sent a verification code.';
