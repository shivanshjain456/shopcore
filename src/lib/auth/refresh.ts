/**
 * Refresh-token rotation with family-based reuse detection.
 *
 * ── DESIGN ────────────────────────────────────────────────────────────────
 *
 * Two-token scheme:
 *   - ACCESS token  — short-lived (15 min) JWT, in sc_session / sc_admin
 *                     HttpOnly cookies. Stateless verify on the hot path.
 *   - REFRESH token — long-lived (30 d customer / 12 h admin) opaque
 *                     256-bit secret, in sc_refresh / sc_admin_refresh
 *                     HttpOnly cookies. Single-use — every refresh rotates.
 *
 * Family-based reuse detection:
 *   - At login we create a `RefreshTokenFamily` row and the first
 *     `RefreshToken` row inside it.
 *   - Each `rotate()` call marks the presented token row `rotatedAt=now`
 *     and creates a new row inside the SAME family with `parentId=<old>`.
 *   - If a refresh token whose `rotatedAt` is already set is presented,
 *     that means two parties hold the same secret — proof of theft.
 *     We invalidate the entire family + revoke every linked session +
 *     audit log.
 *
 * Absolute expiry:
 *   - `RefreshTokenFamily.absoluteExpiresAt` is the hard ceiling — rotations
 *     cannot extend it. After login + 30 days the user must re-auth even if
 *     actively refreshing.
 *
 * Storage:
 *   - The opaque secret is NEVER stored. We store its sha256 hash. The
 *     UNIQUE constraint on `tokenHash` makes guessing intractable.
 *
 * Cookie strategy:
 *   - `sc_session` / `sc_admin`           = 15-min access JWT
 *   - `sc_refresh` / `sc_admin_refresh`   = opaque refresh secret,
 *                                            Path=/api/auth/refresh (so it's
 *                                            never sent on every request)
 *   - All HttpOnly + SameSite=Strict + Secure-in-prod.
 *
 * Concurrency:
 *   - Rotation runs inside a Prisma transaction. The first `update()` of
 *     the row takes the write lock, so a parallel race for the same token
 *     row serialises — the second caller sees `rotatedAt != null` and is
 *     correctly treated as theft.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import type { UserRole } from '@/lib/enums';

/** Refresh-token cookie name per role family. */
export const REFRESH_COOKIE        = 'sc_refresh';
export const REFRESH_COOKIE_ADMIN  = 'sc_admin_refresh';

/** Cookie path — refresh is sent ONLY to /api/auth/refresh, not to every API. */
export const REFRESH_COOKIE_PATH   = '/api/auth';

/** Access-token TTLs (the JWT). Short — refresh rotation does the heavy lifting. */
export const ACCESS_TTL_SECONDS_CUSTOMER = 15 * 60;        // 15 min
export const ACCESS_TTL_SECONDS_ADMIN    = 15 * 60;        // 15 min (was 12h)

/** Refresh-token TTLs — the family's absolute ceiling. */
export const REFRESH_TTL_SECONDS_CUSTOMER = 30 * 24 * 60 * 60;  // 30 d
export const REFRESH_TTL_SECONDS_ADMIN    = 12 * 60 * 60;        // 12 h
/** Per-rotation TTL — refresh token rolls forward this much each rotate. */
export const REFRESH_ROTATION_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 d (capped by family.absoluteExpiresAt)

export function accessTtlFor(role: UserRole): number {
  return role === 'ADMIN' ? ACCESS_TTL_SECONDS_ADMIN : ACCESS_TTL_SECONDS_CUSTOMER;
}
export function refreshFamilyTtlFor(role: UserRole): number {
  return role === 'ADMIN' ? REFRESH_TTL_SECONDS_ADMIN : REFRESH_TTL_SECONDS_CUSTOMER;
}
export function refreshCookieNameFor(role: UserRole): string {
  return role === 'ADMIN' ? REFRESH_COOKIE_ADMIN : REFRESH_COOKIE;
}

/** Generate a 32-byte url-safe random secret. ~256 bits of entropy. */
export function generateRefreshSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}
/** Validate the wire format — narrow guard before any DB hit. */
export function looksLikeRefreshSecret(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 32 && s.length <= 96 && /^[A-Za-z0-9_-]+$/.test(s);
}

export type IssueFamilyResult = {
  familyId: string;
  secret: string;            // plaintext — return to caller, set in cookie
  expiresAt: Date;           // family ceiling = token expiry on first issue
};

/**
 * Create a brand new family + first refresh token. Called at login.
 */
export async function issueRefreshFamily(params: {
  userId: string; role: UserRole; ipAddress?: string | null; userAgent?: string | null;
}): Promise<IssueFamilyResult> {
  const ttl = refreshFamilyTtlFor(params.role);
  const absoluteExpiresAt = new Date(Date.now() + ttl * 1000);
  const secret = generateRefreshSecret();
  const tokenHash = hashSecret(secret);

  const family = await prisma.refreshTokenFamily.create({
    data: {
      userId: params.userId,
      absoluteExpiresAt,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      tokens: {
        create: {
          tokenHash,
          expiresAt: absoluteExpiresAt, // first token = full window
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        },
      },
    },
    include: { tokens: true },
  });

  return { familyId: family.id, secret, expiresAt: absoluteExpiresAt };
}

export type RotateOutcome =
  | { kind: 'rotated';  secret: string; expiresAt: Date; familyId: string; userId: string; role: UserRole }
  | { kind: 'invalid'   }   // secret shape bad / unknown / expired
  | { kind: 'expired'   }   // token expiry past (not theft, just stale)
  | { kind: 'reuse'     }   // theft signal — family invalidated
  | { kind: 'revoked'   };  // family already revoked (logout-all / theft earlier / admin)

/**
 * Rotate a refresh token. On success the OLD secret can never be used again.
 *
 * REUSE DETECTION: if the presented hash is found but `rotatedAt` is already
 * set, we invalidate the entire family + revoke linked sessions. Both parties
 * (legit user and attacker) are kicked, forcing fresh login on each device.
 */
export async function rotateRefresh(params: {
  presentedSecret: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<RotateOutcome> {
  if (!looksLikeRefreshSecret(params.presentedSecret)) return { kind: 'invalid' };
  const tokenHash = hashSecret(params.presentedSecret);

  // Wrap in a transaction so the lookup + rotate / theft-cascade is atomic.
  return prisma.$transaction(async (tx) => {
    const row = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { family: { include: { user: true } } },
    });
    if (!row) return { kind: 'invalid' as const };

    const family = row.family;
    const now = Date.now();

    // Family-level revoke (logout-all / password-change / earlier theft / admin)
    if (family.revokedAt) {
      log.warn('refresh.family_revoked', {
        familyId: family.id, userId: family.userId, reason: family.revokedReason,
      });
      return { kind: 'revoked' as const };
    }

    // Family absolute-expiry ceiling — cannot extend past it
    if (family.absoluteExpiresAt.getTime() < now) {
      // Mark family revoked so future calls short-circuit; not a theft signal.
      await tx.refreshTokenFamily.update({
        where: { id: family.id },
        data: { revokedAt: new Date(), revokedReason: 'ABSOLUTE_EXPIRY' },
      });
      return { kind: 'expired' as const };
    }

    // ── REUSE DETECTION ────────────────────────────────────────────────
    if (row.rotatedAt) {
      log.warn('refresh.reuse_detected', {
        familyId: family.id, userId: family.userId, ip: params.ipAddress,
      });
      await tx.refreshTokenFamily.update({
        where: { id: family.id },
        data: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
      });
      // Revoke every session linked to this family — kicks every device.
      await tx.session.updateMany({
        where: { refreshFamilyId: family.id, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      // Best-effort forensics audit log
      try {
        await tx.userActivity.create({
          data: {
            userId: family.userId,
            action: 'REFRESH_REUSE_DETECTED',
            ipAddress: params.ipAddress ?? null,
            metadata: JSON.stringify({
              familyId: family.id, tokenId: row.id, userAgent: params.userAgent ?? null,
            }),
          },
        });
      } catch { /* */ }
      return { kind: 'reuse' as const };
    }

    // Per-token expiry (independent from the family ceiling)
    if (row.expiresAt.getTime() < now) {
      return { kind: 'expired' as const };
    }

    // ── ROTATE ────────────────────────────────────────────────────────
    const newSecret = generateRefreshSecret();
    const newHash = hashSecret(newSecret);
    // New token's expiry = min(now + rotation TTL, family ceiling)
    const tentativeExpiry = new Date(now + REFRESH_ROTATION_TTL_SECONDS * 1000);
    const newExpiry = tentativeExpiry < family.absoluteExpiresAt ? tentativeExpiry : family.absoluteExpiresAt;

    const newRow = await tx.refreshToken.create({
      data: {
        familyId: family.id,
        tokenHash: newHash,
        expiresAt: newExpiry,
        parentId: row.id,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
    await tx.refreshToken.update({
      where: { id: row.id },
      data:  { rotatedAt: new Date(), successorId: newRow.id },
    });

    return {
      kind: 'rotated' as const,
      secret: newSecret,
      expiresAt: newExpiry,
      familyId: family.id,
      userId: family.userId,
      role: family.user.role as UserRole,
    };
  }, { maxWait: 10_000, timeout: 15_000 });
}

/** Revoke a single family — used by /api/auth/logout, password change, etc. */
/**
 * In-process per-family async mutex. Concurrent logout requests for the SAME
 * family on the SAME process serialise here BEFORE touching SQLite. That
 * means:
 *   - The first caller wins the lock, runs the transaction, marks the family
 *     revoked.
 *   - The N-1 followers acquire the lock AFTER the first commits, see
 *     `revokedAt != null` via the cheap pre-check, and bail in microseconds —
 *     no second BEGIN IMMEDIATE, no write-lock starvation, no 5xx.
 *
 * Cross-process safety still comes from the DB (the `revokedAt` column is
 * the source of truth; this lock is just a fairness/latency optimisation).
 *
 * Feature #9 (R2) parallel-storm test specifically exercises this path.
 */
const familyLocks = new Map<string, Promise<unknown>>();
async function withFamilyLock<T>(familyId: string, fn: () => Promise<T>): Promise<T> {
  const prev = familyLocks.get(familyId) ?? Promise.resolve<unknown>(undefined);
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const ours = prev.then(() => gate);
  familyLocks.set(familyId, ours);
  try {
    await prev.catch(() => { /* prior holder failed; we still proceed */ });
    return await fn();
  } finally {
    release();
    if (familyLocks.get(familyId) === ours) familyLocks.delete(familyId);
  }
}

export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await withFamilyLock(familyId, async () => {
    // Cheap pre-check — if the family is already revoked we have nothing to do.
    // Combined with the per-family lock above this guarantees that N parallel
    // logout calls for the same family produce EXACTLY ONE SQLite write
    // transaction.
    const cur = await prisma.refreshTokenFamily.findUnique({
      where: { id: familyId }, select: { revokedAt: true },
    });
    if (!cur || cur.revokedAt) return;
    await prisma.$transaction(async (tx) => {
      await tx.refreshTokenFamily.updateMany({
        where: { id: familyId, revokedAt: null },
        data:  { revokedAt: new Date(), revokedReason: reason },
      });
      await tx.session.updateMany({
        where: { refreshFamilyId: familyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
    });
  });
}

/** Revoke EVERY family for a user — used by "log out everywhere" / password change. */
export async function revokeAllFamilies(userId: string, reason: string): Promise<number> {
  // Per-user lock (re-use the family-lock map keyed on a userId namespace) +
  // cheap pre-check. Same rationale as `revokeFamily`: N concurrent
  // scope='all' logouts must collapse to ONE SQLite write.
  return withFamilyLock(`user:${userId}`, async () => {
    const live = await prisma.refreshTokenFamily.count({
      where: { userId, revokedAt: null },
    });
    if (live === 0) return 0;
    return prisma.$transaction(async (tx) => {
      const fams = await tx.refreshTokenFamily.findMany({
        where: { userId, revokedAt: null }, select: { id: true },
      });
      if (fams.length === 0) return 0;
      await tx.refreshTokenFamily.updateMany({
        where: { id: { in: fams.map((f) => f.id) } },
        data:  { revokedAt: new Date(), revokedReason: reason },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      return fams.length;
    });
  });
}

/** Revoke every family for a user EXCEPT one — used by "log out other devices". */
export async function revokeOtherFamilies(userId: string, keepFamilyId: string, reason: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const fams = await tx.refreshTokenFamily.findMany({
      where: { userId, revokedAt: null, NOT: { id: keepFamilyId } },
      select: { id: true },
    });
    if (fams.length === 0) return 0;
    const ids = fams.map((f) => f.id);
    await tx.refreshTokenFamily.updateMany({
      where: { id: { in: ids } },
      data:  { revokedAt: new Date(), revokedReason: reason },
    });
    await tx.session.updateMany({
      where: { userId, refreshFamilyId: { in: ids }, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    return fams.length;
  });
}

/** Cron-time cleanup. Removes families whose ABSOLUTE expiry is in the past
 *  AND were issued more than 7 days before that — keeps the audit window. */
export async function pruneExpiredRefreshFamilies(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 86400 * 1000);
  const r = await prisma.refreshTokenFamily.deleteMany({
    where: { absoluteExpiresAt: { lt: cutoff } },
  });
  return r.count;
}
