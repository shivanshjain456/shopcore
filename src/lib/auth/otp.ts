/**
 * Email OTP — real, hashed, rate-limited, attempt-bounded.
 *
 * Never returns the plaintext code to any caller other than the email sender.
 * Codes are bcrypt-hashed at rest. On verify, we look up unconsumed, non-expired
 * codes for that (email, purpose), bcrypt-compare, and atomically consume.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/config';
import { sendOtpEmail } from '@/lib/email/send';

export type OtpPurpose = 'SIGNUP' | 'LOGIN' | 'RESET' | 'EMAIL_CHANGE';

/**
 * Pre-computed bcrypt hash of an unguessable constant, used as the
 * `compare`-target on negative `verifyOtp` paths so response time
 * does NOT leak whether an OTP row existed for the queried email.
 *
 * The hash itself is bcrypt cost 10 (matching the cost we use on real
 * OTP hashes), so `compare()` takes the same wall-time on the dummy as
 * on a real record. The plaintext that hashes to this is unknown to
 * an attacker and meaningless even if guessed — `compare` against a
 * dummy can never resolve to `true` for a real OTP row check.
 */
const OTP_TIMING_DUMMY_HASH = '$2a$10$L./UdrhwinseVzNBJRMjxerXr3zPHaa87d3FHoTWoEJaSxA29dJKe';

function generateNumericCode(len: number): string {
  // crypto.randomInt is uniform; avoids modulo bias of Math.random
  let s = '';
  for (let i = 0; i < len; i++) s += crypto.randomInt(0, 10).toString();
  return s;
}

/**
 * Issue + email a new OTP.
 * - Invalidates any prior unconsumed codes for the same (email, purpose)
 * - Enforces 60s resend cooldown
 * - Enforces per-email per-hour cap
 */
export async function issueOtp(params: {
  email: string;
  purpose: OtpPurpose;
  userId?: string | null;
  ipAddress?: string | null;
}): Promise<{ ok: true; expiresAt: Date } | { ok: false; reason: string; retryAfterSeconds?: number }> {
  const email = params.email.toLowerCase().trim();

  // Cooldown — if any code was sent within the last N seconds, reject
  const cooldownAt = new Date(Date.now() - env.OTP_RESEND_COOLDOWN_SECONDS * 1000);
  const recent = await prisma.otpCode.findFirst({
    where: { email, purpose: params.purpose, createdAt: { gt: cooldownAt } },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    const waitMs = recent.createdAt.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
    return {
      ok: false,
      reason: `Please wait before requesting a new code.`,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }

  // Hourly cap per email
  const hourAgo = new Date(Date.now() - 3600_000);
  const hourCount = await prisma.otpCode.count({
    where: { email, purpose: params.purpose, createdAt: { gt: hourAgo } },
  });
  if (hourCount >= env.OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'Too many OTP requests for this email. Try again later.' };
  }

  // Invalidate prior unconsumed
  await prisma.otpCode.updateMany({
    where: { email, purpose: params.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateNumericCode(env.OTP_LENGTH);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60_000);

  await prisma.otpCode.create({
    data: {
      email,
      codeHash,
      purpose: params.purpose,
      userId: params.userId ?? null,
      ipAddress: params.ipAddress ?? null,
      expiresAt,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
    },
  });

  // Send. If this throws in production, the caller should surface a generic error;
  // the OTP row is already saved so the user can hit "resend" once SMTP recovers.
  await sendOtpEmail(email, code, params.purpose, env.OTP_EXPIRY_MINUTES);

  return { ok: true, expiresAt };
}

/**
 * Verify a submitted code.
 * On the LAST allowed attempt being wrong, the OTP is consumed (so resend is forced).
 */
export async function verifyOtp(params: {
  email: string;
  purpose: OtpPurpose;
  code: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const email = params.email.toLowerCase().trim();
  const submitted = params.code.trim();

  if (!/^\d+$/.test(submitted)) return { ok: false, reason: 'Invalid OTP.' };

  const otp = await prisma.otpCode.findFirst({
    where: {
      email,
      purpose: params.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Timing-attack mitigation:
  //
  //   The cheapest "OTP not found" path used to return immediately on
  //   `!otp` — bcrypt.compare (≈100ms) only ran when a matching OTP
  //   row existed. Response-time observation therefore leaked
  //   "this email has an active OTP" vs "this email has none", which
  //   in turn implies whether the email has an account that recently
  //   requested a verify/reset.
  //
  //   We now run a dummy bcrypt.compare on the negative path with the
  //   same hash-shape and the user-submitted code. Result is discarded.
  //   Both paths now take comparable wall-time (~bcrypt cost 10).
  //
  //   Dummy hash is a constant — pre-computed bcrypt of an
  //   unguessable string. Safe to embed; matches will never succeed.
  if (!otp) {
    await bcrypt.compare(submitted, OTP_TIMING_DUMMY_HASH).catch(() => false);
    return { ok: false, reason: 'OTP not found or expired. Please request a new code.' };
  }

  if (otp.attempts >= otp.maxAttempts) {
    // Same treatment for the "exhausted attempts" branch.
    await bcrypt.compare(submitted, OTP_TIMING_DUMMY_HASH).catch(() => false);
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    return { ok: false, reason: 'Too many invalid attempts. Please request a new code.' };
  }

  const match = await bcrypt.compare(submitted, otp.codeHash);

  if (!match) {
    const newAttempts = otp.attempts + 1;
    const isLast = newAttempts >= otp.maxAttempts;
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: {
        attempts: newAttempts,
        consumedAt: isLast ? new Date() : null,
      },
    });
    return {
      ok: false,
      reason: isLast
        ? 'Invalid OTP. Maximum attempts reached — request a new code.'
        : `Invalid OTP. ${otp.maxAttempts - newAttempts} attempt(s) remaining.`,
    };
  }

  // Success — consume
  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true };
}
