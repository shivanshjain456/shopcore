/**
 * Phone Verification — test suite.
 *
 *   npm run test:phone-verification
 *
 * Five tiers:
 *
 *   1. UNIT (pure)
 *      - normalisePhone / maskPhone / Zod schema
 *      - state-machine helpers for PENDING_PHONE_VERIFICATION
 *      - canTransition for every new edge
 *      - Firebase error-code map completeness
 *
 *   2. SERVICE (real DB, no server)
 *      - verifyPhoneCredential happy path (dev-bypass)
 *      - PHONE_MISMATCH (3-way), PHONE_TAKEN, PHONE_ALREADY_LINKED
 *      - INVALID_STATE
 *      - Idempotency on already-verified ACTIVE user
 *      - DEV_BYPASS_REJECTED under simulated production
 *      - updateUserPhone: state hop, family revocation, columns reset
 *      - markPhoneVerifiedByAdmin: AuditLog, UserActivity, state hop
 *
 *   3. INTEGRATION (real `next start`)
 *      - Full new-registration HTTP flow: signup → email OTP → phone OTP → ACTIVE
 *      - Middleware redirects PENDING_PHONE_VERIFICATION away from /account
 *      - Resend rate-limit hits 429 on the 4th call
 *      - PATCH /api/account/phone forces re-verification + revokes families
 *      - Admin override route + AuditLog row present
 *      - JWT carries `status` claim (decoded via jose decodeJwt)
 *
 *   4. STATIC AUDIT
 *      - 'dev-bypass-token' literal appears only in service + verify route
 *      - No client component imports firebase-admin
 *      - verifyIdToken called only inside firebasePhone.ts
 *
 *   5. CLEANUP — deterministic TAG, finally block.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import { UserStatus } from '../src/lib/enums';
import {
  canTransition, isLoginPermitted, isOrderPermitted, isWritePermitted,
} from '../src/lib/auth/accountStateMachine';
import {
  verifyPhoneCredential, updateUserPhone, markPhoneVerifiedByAdmin,
  normalisePhone, maskPhone, DEV_BYPASS_TOKEN,
} from '../src/lib/auth/phoneVerification';
import { PhoneVerifyBodySchema } from '../src/lib/auth/schemas';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import { SignJWT, decodeJwt } from 'jose';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  writeFileSync, readFileSync, existsSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Test harness ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) ok(label); else fail(label, true, detail ?? false);
}

const TAG = `phone_verify_test_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
function freshPhone10(): string {
  // 10-digit Indian mobile starting 9
  return '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
}
function freshPhoneE164(): string { return '+91' + freshPhone10(); }

async function makeUser(label: string, opts: {
  status?: typeof UserStatus[keyof typeof UserStatus];
  phone?: string;
  phoneVerified?: boolean;
  firebasePhoneUid?: string | null;
  role?: 'CUSTOMER' | 'ADMIN' | 'B2B';
} = {}) {
  return prisma.user.create({
    data: {
      firstName: 'Pv', lastName: label,
      email: `${TAG}_${label}@shopcore.test`,
      phone: opts.phone ?? freshPhoneE164(),
      passwordHash: await hashPassword('Sm0kyM#7QrXa'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: opts.role ?? 'CUSTOMER',
      // STATE_MACHINE_BYPASS: test-fixture seeding — initial-row insert,
      // not a runtime transition. Same convention used by every other
      // test in the suite.
      status: opts.status ?? UserStatus.PENDING_PHONE_VERIFICATION,
      phoneVerified: opts.phoneVerified ?? false,
      firebasePhoneUid: opts.firebasePhoneUid ?? null,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
}

// ────────────────────────────────────────────────────────────── 1. UNIT
function unitTests() {
  console.log('\n── UNIT — pure functions ──');

  // Normalisation
  eq('(N1) "9876543210" → +919876543210',                '+919876543210', normalisePhone('9876543210'));
  eq('(N1) "+91 98765 43210" → +919876543210',           '+919876543210', normalisePhone('+91 98765 43210'));
  eq('(N1) "091-9876543210" → +919876543210',            '+919876543210', normalisePhone('091-9876543210'));
  eq('(N1) "+919876543210" passes through unchanged',    '+919876543210', normalisePhone('+919876543210'));
  eq('(N1) "919876543210" → +919876543210',              '+919876543210', normalisePhone('919876543210'));
  eq('(N1) leading-5 landline rejected',                 null,           normalisePhone('+915876543210'));
  eq('(N1) US prefix rejected',                          null,           normalisePhone('+14155552671'));
  eq('(N1) too short rejected',                          null,           normalisePhone('98765432'));
  eq('(N1) too long rejected',                           null,           normalisePhone('98765432109'));
  eq('(N1) empty rejected',                              null,           normalisePhone(''));
  eq('(N1) garbage rejected',                            null,           normalisePhone('abcdef'));

  // Mask
  eq('(N2) maskPhone(+919876543210) = +91******3210',    '+91******3210', maskPhone('+919876543210'));
  eq('(N2) maskPhone("") = ""',                           '',              maskPhone(''));
  eq('(N2) maskPhone(short)',                             '****',          maskPhone('1234'));

  // Zod schema
  assert('(N3) Zod accepts +919876543210',
    PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '+919876543210' }).success);
  assert('(N3) Zod accepts bare 9876543210 (transforms)',
    PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '9876543210' }).success);
  assert('(N3) Zod REJECTS landline +911187654321',
    !PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '+911187654321' }).success);
  assert('(N3) Zod REJECTS US +14155552671',
    !PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '+14155552671' }).success);
  assert('(N3) Zod REJECTS too-short idToken',
    !PhoneVerifyBodySchema.safeParse({ idToken: 'abc', phone: '+919876543210' }).success);
  assert('(N3) Zod REJECTS too-short phone',
    !PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '987' }).success);
  assert('(N3) Zod REJECTS too-long phone',
    !PhoneVerifyBodySchema.safeParse({ idToken: 'x'.repeat(20), phone: '98765432101111' }).success);

  // State helpers
  eq('(N4) isLoginPermitted(PENDING_PHONE_VERIFICATION) = true',
    true, isLoginPermitted(UserStatus.PENDING_PHONE_VERIFICATION));
  eq('(N4) isOrderPermitted(PENDING_PHONE_VERIFICATION) = false',
    false, isOrderPermitted(UserStatus.PENDING_PHONE_VERIFICATION));
  eq('(N4) isWritePermitted(PENDING_PHONE_VERIFICATION) = false',
    false, isWritePermitted(UserStatus.PENDING_PHONE_VERIFICATION));

  // canTransition
  eq('(N5) PENDING_OTP → PENDING_PHONE_VERIFICATION (SYSTEM) = true',
    true, canTransition(UserStatus.PENDING_OTP, UserStatus.PENDING_PHONE_VERIFICATION, { type: 'SYSTEM' }));
  eq('(N5) PENDING_PHONE_VERIFICATION → ACTIVE (SYSTEM) = true',
    true, canTransition(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.ACTIVE, { type: 'SYSTEM' }));
  eq('(N5) PENDING_PHONE_VERIFICATION → ACTIVE (ADMIN) = false',
    false, canTransition(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.ACTIVE, { type: 'ADMIN', adminId: 'x' }));
  eq('(N5) ACTIVE → PENDING_PHONE_VERIFICATION (SYSTEM) = true',
    true, canTransition(UserStatus.ACTIVE, UserStatus.PENDING_PHONE_VERIFICATION, { type: 'SYSTEM' }));
  eq('(N5) PENDING_PHONE_VERIFICATION → SUSPENDED (ADMIN) = true',
    true, canTransition(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.SUSPENDED, { type: 'ADMIN', adminId: 'x' }));
  eq('(N5) PENDING_PHONE_VERIFICATION → DELETED (ADMIN) = true',
    true, canTransition(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.DELETED, { type: 'ADMIN', adminId: 'x' }));
  eq('(N5) PENDING_PHONE_VERIFICATION → ACTIVE (SELF) = false',
    false, canTransition(UserStatus.PENDING_PHONE_VERIFICATION, UserStatus.ACTIVE, { type: 'SELF', userId: 'x' }));

  // Firebase error code map — verify all advertised codes have a non-empty mapping.
  // Done by parsing the form file at static path. This guards against a
  // future rename that silently drops a row.
  const formSrc = readFileSync('src/components/auth/PhoneVerificationForm.tsx', 'utf8');
  const required = [
    'auth/invalid-verification-code',
    'auth/code-expired',
    'auth/too-many-requests',
    'auth/invalid-phone-number',
    'auth/network-request-failed',
  ];
  for (const code of required) {
    const re = new RegExp(`['"]${code.replace(/[/-]/g, '\\$&')}['"]\\s*:\\s*['"][^'"]+['"]`);
    assert(`(N6) FIREBASE_ERROR_MESSAGES has non-empty entry for "${code}"`, re.test(formSrc));
  }
  // DEV_BYPASS_TOKEN constant is the expected literal.
  eq('(N7) DEV_BYPASS_TOKEN literal = "dev-bypass-token"',
    'dev-bypass-token', DEV_BYPASS_TOKEN);
}

// ────────────────────────────────────────────────────────────── 2. SERVICE
async function serviceTests() {
  console.log('\n── SERVICE — phoneVerification (real DB) ──');
  const admin = await makeUser('svc_admin', { status: UserStatus.ACTIVE, role: 'ADMIN', phoneVerified: true });

  // (S1) Happy path — PENDING_PHONE_VERIFICATION → ACTIVE via dev-bypass.
  const u1Phone = freshPhoneE164();
  const u1 = await makeUser('s1', { status: UserStatus.PENDING_PHONE_VERIFICATION, phone: u1Phone });
  const r1 = await verifyPhoneCredential(u1.id, DEV_BYPASS_TOKEN, u1Phone);
  assert('(S1) verifyPhoneCredential happy path returns ok', r1.ok);
  if (r1.ok) {
    eq('(S1) accountStatus is ACTIVE', UserStatus.ACTIVE, r1.data.accountStatus);
    eq('(S1) alreadyVerified is false', false, r1.data.alreadyVerified);
  }
  const u1After = await prisma.user.findUniqueOrThrow({ where: { id: u1.id } });
  eq('(S1) DB phoneVerified=true',           true, u1After.phoneVerified);
  assert('(S1) DB phoneVerifiedAt is set',   u1After.phoneVerifiedAt !== null);
  assert('(S1) DB firebasePhoneUid is set',  u1After.firebasePhoneUid !== null);
  eq('(S1) DB status=ACTIVE',                UserStatus.ACTIVE, u1After.status);

  // UserActivity PHONE_VERIFIED row exists.
  const acts1 = await prisma.userActivity.findMany({ where: { userId: u1.id, action: 'PHONE_VERIFIED' } });
  assert(`(S1) UserActivity PHONE_VERIFIED row (got ${acts1.length})`, acts1.length >= 1);

  // SYSTEM transition does NOT write AuditLog (machine convention).
  const auditsS1 = await prisma.auditLog.findMany({
    where: { entity: 'User', entityId: u1.id, action: { startsWith: 'ACCOUNT_STATE_TRANSITION' } },
  });
  eq('(S1) AuditLog NOT written for SYSTEM transition', 0, auditsS1.length);

  // (S2) PHONE_MISMATCH — submitted phone ≠ DB phone.
  const u2 = await makeUser('s2', { status: UserStatus.PENDING_PHONE_VERIFICATION });
  const wrong = freshPhoneE164();
  const r2 = await verifyPhoneCredential(u2.id, DEV_BYPASS_TOKEN, wrong);
  assert('(S2) PHONE_MISMATCH returns !ok', !r2.ok);
  if (!r2.ok) eq('(S2) reason = PHONE_MISMATCH', 'PHONE_MISMATCH', r2.reason);

  // (S3) PHONE_TAKEN — another verified user holds the same number.
  //
  // The `User.phone` column carries a global UNIQUE index (Feature #11),
  // so we cannot create two ROWS with the same phone. We exercise the
  // service's PHONE_TAKEN branch by: (a) creating user A with phone P
  // verified, (b) creating user B with a DIFFERENT phone, then (c)
  // temporarily swapping user B's phone to P (direct write — bypasses
  // the unique index? no, it doesn't; instead we DROP user A's phone
  // first, then put user B on P, then re-introduce a verified row with
  // P). Simpler: assert the rejection via the underlying SQL race
  // pattern by creating a SECOND user with a unique phone, then run the
  // service with `submittedPhone === A.phone` and watch it reject as
  // PHONE_MISMATCH on the three-way check — that's a different reason.
  //
  // To actually hit PHONE_TAKEN we need TWO rows with the same phone.
  // SQLite enforces UNIQUE, so we instead inject the takeover signal
  // by direct-updating user B's phone to A's phone via a raw SQL UPDATE
  // that bypasses Prisma's constraint check (sqlite still enforces the
  // index — there's NO way around). Hence: skip the dual-row staging
  // and prove PHONE_TAKEN via the integration-tier flow (I6 covers a
  // similar surface). We assert the branch behaviour exists by tripping
  // PHONE_TAKEN through a temporary index-disable hack:
  //
  //   1. Drop the unique index
  //   2. Create the two rows
  //   3. Run verify → expect PHONE_TAKEN
  //   4. Restore the unique index
  //
  // This is local to the SERVICE tier and reverted in `finally`.
  const sharedPhone = freshPhoneE164();
  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "User_phone_key"');
  let u3a: { id: string; phone: string } | null = null;
  let u3b: { id: string; phone: string } | null = null;
  try {
    u3a = await makeUser('s3a', {
      status: UserStatus.ACTIVE, phone: sharedPhone, phoneVerified: true,
      firebasePhoneUid: `fb-${TAG}-3a`,
    });
    u3b = await makeUser('s3b', { status: UserStatus.PENDING_PHONE_VERIFICATION, phone: sharedPhone });
    const r3 = await verifyPhoneCredential(u3b.id, DEV_BYPASS_TOKEN, sharedPhone);
    assert('(S3) PHONE_TAKEN returns !ok', !r3.ok);
    if (!r3.ok) eq('(S3) reason = PHONE_TAKEN', 'PHONE_TAKEN', r3.reason);
  } finally {
    // Restore the unique index BEFORE any other test creates more rows.
    if (u3b) await prisma.user.update({
      where: { id: u3b.id }, data: { phone: freshPhoneE164() },
    });
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone")',
    );
  }

  // (S4) PHONE_ALREADY_LINKED — user has a different Firebase UID set.
  const u4Phone = freshPhoneE164();
  const u4 = await makeUser('s4', {
    status: UserStatus.PENDING_PHONE_VERIFICATION, phone: u4Phone,
    firebasePhoneUid: `fb-OTHER-${TAG}-4`,
  });
  // Dev-bypass synthesises firebaseUid as `dev-bypass-<userId>` — different from the seeded one.
  const r4 = await verifyPhoneCredential(u4.id, DEV_BYPASS_TOKEN, u4Phone);
  assert('(S4) PHONE_ALREADY_LINKED returns !ok', !r4.ok);
  if (!r4.ok) eq('(S4) reason = PHONE_ALREADY_LINKED', 'PHONE_ALREADY_LINKED', r4.reason);

  // (S5) INVALID_STATE — user is SUSPENDED.
  const u5 = await makeUser('s5', { status: UserStatus.SUSPENDED });
  const r5 = await verifyPhoneCredential(u5.id, DEV_BYPASS_TOKEN, u5.phone);
  assert('(S5) SUSPENDED user returns !ok', !r5.ok);
  if (!r5.ok) eq('(S5) reason = INVALID_STATE', 'INVALID_STATE', r5.reason);

  // (S6) DEV_BYPASS_REJECTED under simulated production.
  const savedNodeEnv = process.env.NODE_ENV;
  // env.NODE_ENV is a snapshot — but the service reads `env.NODE_ENV` not
  // process.env directly. We mutate the imported `env` object (it's a
  // simple data object after Zod parse) for the duration of this check.
  const u6 = await makeUser('s6', { status: UserStatus.PENDING_PHONE_VERIFICATION });
  const envMut = env as unknown as { NODE_ENV: string };
  const realNodeEnv = envMut.NODE_ENV;
  envMut.NODE_ENV = 'production';
  try {
    const r6 = await verifyPhoneCredential(u6.id, DEV_BYPASS_TOKEN, u6.phone);
    assert('(S6) production guard rejects dev-bypass', !r6.ok);
    if (!r6.ok) eq('(S6) reason = DEV_BYPASS_REJECTED', 'DEV_BYPASS_REJECTED', r6.reason);
  } finally {
    envMut.NODE_ENV = realNodeEnv;
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  }

  // (S7) Idempotency — already-ACTIVE + phoneVerified user re-submits.
  const u7Phone = freshPhoneE164();
  const u7 = await makeUser('s7', { status: UserStatus.PENDING_PHONE_VERIFICATION, phone: u7Phone });
  const first  = await verifyPhoneCredential(u7.id, DEV_BYPASS_TOKEN, u7Phone);
  assert('(S7) first verify ok', first.ok);
  const second = await verifyPhoneCredential(u7.id, DEV_BYPASS_TOKEN, u7Phone);
  assert('(S7) second (idempotent) verify ok', second.ok);
  if (second.ok) eq('(S7) alreadyVerified=true on second call', true, second.data.alreadyVerified);
  // No DUPLICATE UserActivity row from the idempotent call (we expect 1 only).
  const acts7 = await prisma.userActivity.findMany({ where: { userId: u7.id, action: 'PHONE_VERIFIED' } });
  eq('(S7) exactly one PHONE_VERIFIED activity row', 1, acts7.length);

  // (S8) updateUserPhone — ACTIVE user changes phone.
  const u8 = await makeUser('s8', {
    status: UserStatus.ACTIVE, phoneVerified: true,
    firebasePhoneUid: `fb-${TAG}-8`,
  });
  // Give the user a live refresh family so we can prove revocation.
  await issueRefreshFamily({ userId: u8.id, role: 'CUSTOMER' });
  const liveBefore = await prisma.refreshTokenFamily.count({ where: { userId: u8.id, revokedAt: null } });
  assert('(S8) live family exists pre-update', liveBefore >= 1);
  const newPhone = freshPhoneE164();
  const r8 = await updateUserPhone(u8.id, newPhone);
  assert('(S8) updateUserPhone ok', r8.ok);
  if (r8.ok) {
    eq('(S8) returned phone is normalised', newPhone, r8.data.phone);
    eq('(S8) requiresVerification=true', true, r8.data.requiresVerification);
  }
  const u8After = await prisma.user.findUniqueOrThrow({ where: { id: u8.id } });
  eq('(S8) phone updated',          newPhone, u8After.phone);
  eq('(S8) phoneVerified=false',    false,    u8After.phoneVerified);
  eq('(S8) phoneVerifiedAt cleared', null,    u8After.phoneVerifiedAt);
  eq('(S8) firebasePhoneUid cleared', null,   u8After.firebasePhoneUid);
  eq('(S8) status=PENDING_PHONE_VERIFICATION', UserStatus.PENDING_PHONE_VERIFICATION, u8After.status);
  const liveAfter = await prisma.refreshTokenFamily.count({ where: { userId: u8.id, revokedAt: null } });
  eq('(S8) refresh families revoked', 0, liveAfter);
  // UserActivity row for PHONE_CHANGED.
  const acts8 = await prisma.userActivity.findMany({ where: { userId: u8.id, action: 'PHONE_CHANGED' } });
  eq('(S8) PHONE_CHANGED activity row', 1, acts8.length);

  // (S9) updateUserPhone — PHONE_TAKEN rejection. Create a verified user
  // holding a known phone, then try to update a DIFFERENT user's phone
  // to that same number.
  const takenPhone = freshPhoneE164();
  const u9Other = await makeUser('s9other', {
    status: UserStatus.ACTIVE, phone: takenPhone, phoneVerified: true,
  });
  const u9 = await makeUser('s9', { status: UserStatus.ACTIVE, phoneVerified: true });
  const r9 = await updateUserPhone(u9.id, takenPhone);
  assert('(S9) updateUserPhone rejected (PHONE_TAKEN)', !r9.ok);
  if (!r9.ok) eq('(S9) reason = PHONE_TAKEN', 'PHONE_TAKEN', r9.reason);
  void u9Other;

  // (S10) updateUserPhone — INVALID_PHONE rejection.
  const r10 = await updateUserPhone(u9.id, '12345');
  assert('(S10) invalid phone rejected', !r10.ok);
  if (!r10.ok) eq('(S10) reason = INVALID_PHONE', 'INVALID_PHONE', r10.reason);

  // (S11) markPhoneVerifiedByAdmin — admin override path.
  const u11 = await makeUser('s11', { status: UserStatus.PENDING_PHONE_VERIFICATION });
  const r11 = await markPhoneVerifiedByAdmin(u11.id, admin.id);
  assert('(S11) admin override ok', r11.ok);
  if (r11.ok) {
    eq('(S11) accountStatus=ACTIVE', UserStatus.ACTIVE, r11.data.accountStatus);
    eq('(S11) alreadyVerified=false', false, r11.data.alreadyVerified);
  }
  const u11After = await prisma.user.findUniqueOrThrow({ where: { id: u11.id } });
  eq('(S11) phoneVerified=true', true, u11After.phoneVerified);
  eq('(S11) status=ACTIVE',      UserStatus.ACTIVE, u11After.status);
  const audits11 = await prisma.auditLog.findMany({
    where: { entity: 'User', entityId: u11.id, action: 'ADMIN_PHONE_VERIFY_OVERRIDE' },
  });
  eq('(S11) ADMIN_PHONE_VERIFY_OVERRIDE audit row', 1, audits11.length);
  eq('(S11) audit row carries admin.id as actorId', admin.id, audits11[0].actorId);

  // (S12) markPhoneVerifiedByAdmin on USER_NOT_FOUND.
  const r12 = await markPhoneVerifiedByAdmin('does-not-exist', admin.id);
  assert('(S12) USER_NOT_FOUND returns !ok', !r12.ok);
  if (!r12.ok) eq('(S12) reason = USER_NOT_FOUND', 'USER_NOT_FOUND', r12.reason);

  void admin;
}

// ────────────────────────────────────────────────────────────── 3. INTEGRATION
const PORT = 3049;
const BASE = `http://127.0.0.1:${PORT}`;
const OTP_FILE = `/tmp/test-phone-verification-otp-${process.pid}.jsonl`;
process.env.SHOPCORE_TEST_OTP_FILE = OTP_FILE;
try { if (existsSync(OTP_FILE)) unlinkSync(OTP_FILE); } catch { /* */ }

interface CapturedOtp { email: string; code: string; purpose: string; ts: number; }
function latestOtpFor(email: string, purpose: string = 'SIGNUP'): string | null {
  if (!existsSync(OTP_FILE)) return null;
  const lines = readFileSync(OTP_FILE, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = JSON.parse(lines[i]) as CapturedOtp;
    if (o.email === email && o.purpose === purpose) return o.code;
  }
  return null;
}

let serverProc: ChildProcess | null = null;
async function startServer() {
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SHOPCORE_ALLOW_TEST_EMAILS: '1',
      SHOPCORE_TEST_OTP_FILE: OTP_FILE,
      // NOTE: We deliberately do NOT set SHOPCORE_DISABLE_RATE_LIMITS
      // here — (I7) asserts the `auth.phone.resend` policy actually
      // returns 429 on the 4th call. The total request count for this
      // suite stays comfortably under the 120-req/min global cap.
    },
    detached: true,
  });
  const killGroup = () => {
    if (serverProc && serverProc.pid && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    }
  };
  process.on('exit', killGroup);
  process.on('SIGINT',  () => { killGroup(); process.exit(130); });
  process.on('SIGTERM', () => { killGroup(); process.exit(143); });
  process.on('uncaughtException',  (e) => { killGroup(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { killGroup(); console.error(e); process.exit(1); });
  const out = (b: Buffer) => writeFileSync('/tmp/test-phone-verification.log', b, { flag: 'a' });
  serverProc.stdout?.on('data', out);
  serverProc.stderr?.on('data', out);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not start');
}
async function stopServer() {
  if (serverProc && serverProc.pid && !serverProc.killed) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

interface Jar { cookies: Record<string, string>; }
function newJar(): Jar { return { cookies: {} }; }
function applySetCookies(jar: Jar, res: Response) {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (v === '' || /Max-Age=0/i.test(sc)) delete jar.cookies[k];
      else jar.cookies[k] = v;
    }
  }
}
function cookieHeader(jar: Jar) {
  return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function getCookie(jar: Jar, name: string): string | null {
  return jar.cookies[name] ?? null;
}
async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown; redirect?: RequestRedirect }) {
  const headers = new Headers();
  if (Object.keys(jar.cookies).length) headers.set('cookie', cookieHeader(jar));
  if (init?.json !== undefined) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && jar.cookies['sc_csrf']) {
    headers.set('x-csrf-token', jar.cookies['sc_csrf']);
  }
  if (!headers.has('origin')) headers.set('origin', BASE);
  const res = await fetch(BASE + path, {
    method, headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: init?.redirect ?? 'manual',
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body, headers: res.headers };
}

async function makeAdminJar() {
  const adminEmail = `${TAG}_int_admin@shopcore.test`;
  const admin = await prisma.user.create({
    data: {
      firstName: 'Pv', lastName: 'IntAdmin', email: adminEmail,
      phone: freshPhoneE164(),
      passwordHash: await hashPassword('Sm0kyM#7QrXa'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: test-fixture seeding.
      status: UserStatus.ACTIVE,
      phoneVerified: true,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  const fam = await issueRefreshFamily({ userId: admin.id, role: 'ADMIN' });
  const ttl = accessTtlFor('ADMIN');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: admin.id, role: admin.role, email: admin.email,
    jti: sessionId, fam: fam.familyId, status: admin.status,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await prisma.session.create({ data: {
    id: sessionId, userId: admin.id, tokenHash, expiresAt, refreshFamilyId: fam.familyId,
  }});
  const jar = newJar();
  await api(jar, '/api/auth/csrf');
  jar.cookies['sc_admin'] = jwt;
  jar.cookies['sc_admin_refresh'] = fam.secret;
  return { admin, jar };
}

async function integrationTests() {
  console.log('\n── INTEGRATION — HTTP flows ──');

  // ── (I1) Full new-registration flow ──────────────────────────────────
  const jar = newJar();
  await api(jar, '/api/auth/csrf');
  const email = `${TAG}_int_new@shopcore.test`;
  const phone10 = freshPhone10();
  const phoneE164 = '+91' + phone10;

  const su = await api(jar, '/api/auth/signup', { method: 'POST', json: {
    firstName: 'Int', lastName: 'New', email, phone: phone10,
    password: 'Sm0kyM#7QrXa', confirmPassword: 'Sm0kyM#7QrXa',
    addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
    pinCode: '400001', country: 'India',
  } });
  if (su.status !== 200) console.error('signup body:', JSON.stringify(su.body));
  eq('(I1) signup → 200', 200, su.status);

  await new Promise((r) => setTimeout(r, 300));
  const code = latestOtpFor(email, 'SIGNUP');
  assert('(I1) email OTP captured from file', !!code);

  const v = await api(jar, '/api/auth/otp/verify', { method: 'POST', json: {
    email, purpose: 'SIGNUP', code,
  } });
  eq('(I1) /otp/verify → 200', 200, v.status);
  const vData = (v.body as { data: { nextStep?: string; redirectTo?: string; next?: string } }).data;
  eq('(I1) response.nextStep = PHONE_VERIFICATION', 'PHONE_VERIFICATION', vData.nextStep);
  assert(`(I1) response.redirectTo starts with /verify-phone (got ${vData.redirectTo})`,
    typeof vData.redirectTo === 'string' && vData.redirectTo.startsWith('/verify-phone'));

  // DB row is now in PENDING_PHONE_VERIFICATION
  const userAfterEmail = await prisma.user.findUniqueOrThrow({ where: { email } });
  eq('(I1) DB status = PENDING_PHONE_VERIFICATION', UserStatus.PENDING_PHONE_VERIFICATION, userAfterEmail.status);

  // JWT carries the status claim now.
  const sessionToken = getCookie(jar, 'sc_session');
  assert('(I1) sc_session cookie set after email verify', !!sessionToken);
  if (sessionToken) {
    const claims = decodeJwt(sessionToken) as { status?: string; sub?: string };
    eq('(I1) JWT.status = PENDING_PHONE_VERIFICATION', UserStatus.PENDING_PHONE_VERIFICATION, claims.status);
    eq('(I1) JWT.sub = user.id', userAfterEmail.id, claims.sub);
  }

  // (I2) Middleware redirects PENDING_PHONE_VERIFICATION away from /account
  const redirRes = await api(jar, '/account');
  assert(`(I2) /account redirects (status=${redirRes.status})`,
    redirRes.status === 307 || redirRes.status === 308 || redirRes.status === 302);
  const loc = redirRes.headers.get('location') ?? '';
  assert(`(I2) location → /verify-phone (got ${loc})`, loc.includes('/verify-phone'));

  // (I3) /verify-phone endpoint is allowed.
  const pp = await api(jar, '/verify-phone');
  assert(`(I3) /verify-phone reachable (status=${pp.status})`,
    pp.status === 200 || pp.status === 307 || pp.status === 308);

  // (I4) Phone verify with dev-bypass → ACTIVE.
  const pv = await api(jar, '/api/auth/phone/verify', { method: 'POST', json: {
    idToken: DEV_BYPASS_TOKEN, phone: phoneE164,
  } });
  eq('(I4) /api/auth/phone/verify → 200', 200, pv.status);
  const pvData = (pv.body as { data: { accountStatus?: string; phoneVerified?: boolean } }).data;
  eq('(I4) accountStatus = ACTIVE', UserStatus.ACTIVE, pvData.accountStatus);
  eq('(I4) phoneVerified = true', true, pvData.phoneVerified);

  const userActive = await prisma.user.findUniqueOrThrow({ where: { email } });
  eq('(I4) DB status = ACTIVE',         UserStatus.ACTIVE, userActive.status);
  eq('(I4) DB phoneVerified = true',    true,              userActive.phoneVerified);

  // (I5) /account is now accessible.
  const acct = await api(jar, '/account');
  assert(`(I5) /account is now reachable (status=${acct.status})`,
    acct.status === 200);

  // ── (I6) PHONE_MISMATCH at the HTTP layer ────────────────────────────
  const jarBad = newJar();
  await api(jarBad, '/api/auth/csrf');
  const badEmail = `${TAG}_int_bad@shopcore.test`;
  const badPhone10 = freshPhone10();
  const badSu = await api(jarBad, '/api/auth/signup', { method: 'POST', json: {
    firstName: 'Int', lastName: 'Bad', email: badEmail, phone: badPhone10,
    password: 'Sm0kyM#7QrXa', confirmPassword: 'Sm0kyM#7QrXa',
    addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
    pinCode: '400001', country: 'India',
  } });
  if (badSu.status === 200) {
    await new Promise((r) => setTimeout(r, 300));
    const c2 = latestOtpFor(badEmail, 'SIGNUP');
    if (c2) await api(jarBad, '/api/auth/otp/verify', { method: 'POST', json: {
      email: badEmail, purpose: 'SIGNUP', code: c2,
    }});
    const submitWrong = freshPhoneE164();
    const r6 = await api(jarBad, '/api/auth/phone/verify', { method: 'POST', json: {
      idToken: DEV_BYPASS_TOKEN, phone: submitWrong,
    } });
    eq('(I6) phone-mismatch → 400', 400, r6.status);
    eq('(I6) error code = PHONE_MISMATCH', 'PHONE_MISMATCH', r6.body.code);
  }

  // ── (I7) Resend rate-limit (3/hour/IP) → 4th attempt 429 ─────────────
  // Reuse the jar from I1 (now ACTIVE). The route allows ACTIVE state.
  let lastStatus = 0;
  for (let i = 0; i < 4; i++) {
    const rr = await api(jar, '/api/auth/phone/resend-otp', { method: 'POST', json: { phone: phoneE164 } });
    lastStatus = rr.status;
  }
  eq('(I7) 4th resend → 429', 429, lastStatus);

  // ── (I8) PATCH /api/account/phone — forces re-verification ───────────
  // Re-issue session jar for the now-ACTIVE user (the resend-test left rate-
  // limiter state on this jar but cookies are still fine).
  const newPhone10 = freshPhone10();
  const newPhoneE164 = '+91' + newPhone10;
  const liveBefore = await prisma.refreshTokenFamily.count({ where: { userId: userActive.id, revokedAt: null } });
  assert('(I8) live family pre-patch', liveBefore >= 1);
  const patch = await api(jar, '/api/account/phone', { method: 'PATCH', json: { phone: newPhone10 } });
  eq('(I8) PATCH /api/account/phone → 200', 200, patch.status);
  const patchData = (patch.body as { data: { phone: string; requiresVerification: boolean } }).data;
  eq('(I8) new phone normalised', newPhoneE164, patchData.phone);
  eq('(I8) requiresVerification=true', true, patchData.requiresVerification);
  const liveAfter = await prisma.refreshTokenFamily.count({ where: { userId: userActive.id, revokedAt: null } });
  eq('(I8) families revoked after phone change', 0, liveAfter);
  const userAfterPatch = await prisma.user.findUniqueOrThrow({ where: { id: userActive.id } });
  eq('(I8) status = PENDING_PHONE_VERIFICATION', UserStatus.PENDING_PHONE_VERIFICATION, userAfterPatch.status);
  eq('(I8) phoneVerified = false',                false,                                  userAfterPatch.phoneVerified);
  eq('(I8) firebasePhoneUid cleared',             null,                                   userAfterPatch.firebasePhoneUid);

  // ── (I9) Admin override path ─────────────────────────────────────────
  const { admin, jar: adminJar } = await makeAdminJar();
  const targetPhone = freshPhoneE164();
  const target = await prisma.user.create({
    data: {
      firstName: 'Pv', lastName: 'IntTarget',
      email: `${TAG}_int_target@shopcore.test`,
      phone: targetPhone,
      passwordHash: await hashPassword('Sm0kyM#7QrXa'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'CUSTOMER',
      // STATE_MACHINE_BYPASS: test-fixture seeding.
      status: UserStatus.PENDING_PHONE_VERIFICATION,
      phoneVerified: false,
      referralCode: 'R' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    },
  });
  const adminR = await api(adminJar, `/api/admin/customers/${target.id}/verify-phone`, { method: 'POST', json: {} });
  eq('(I9) admin override → 200', 200, adminR.status);
  const tAfter = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
  eq('(I9) target.phoneVerified=true', true, tAfter.phoneVerified);
  eq('(I9) target.status=ACTIVE',      UserStatus.ACTIVE, tAfter.status);
  const auditsAdmin = await prisma.auditLog.findMany({
    where: { entity: 'User', entityId: target.id, action: 'ADMIN_PHONE_VERIFY_OVERRIDE' },
  });
  eq('(I9) ADMIN_PHONE_VERIFY_OVERRIDE audit row', 1, auditsAdmin.length);
  eq('(I9) audit.actorId = admin.id', admin.id, auditsAdmin[0].actorId);

  // ── (I10) Backwards-compat: existing JWT without status claim still
  //         passes middleware → /account reachable. We forge a JWT WITHOUT
  //         the status claim and use it.
  const compatUser = await makeUser('compat', { status: UserStatus.ACTIVE, phoneVerified: true });
  const compatFam = await issueRefreshFamily({ userId: compatUser.id, role: 'CUSTOMER' });
  const compatTtl = accessTtlFor('CUSTOMER');
  const compatExp = new Date(Date.now() + compatTtl * 1000);
  const compatSessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  // Note: NO status claim — this is the legacy JWT shape.
  const compatJwt = await new SignJWT({
    sub: compatUser.id, role: compatUser.role, email: compatUser.email,
    jti: compatSessionId, fam: compatFam.familyId,
  }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(compatExp).sign(secret);
  const tokenHash = crypto.createHash('sha256').update(compatJwt).digest('hex');
  await prisma.session.create({ data: {
    id: compatSessionId, userId: compatUser.id, tokenHash, expiresAt: compatExp,
    refreshFamilyId: compatFam.familyId,
  }});
  const compatJar = newJar();
  await api(compatJar, '/api/auth/csrf');
  compatJar.cookies['sc_session'] = compatJwt;
  compatJar.cookies['sc_refresh'] = compatFam.secret;
  const compatAcct = await api(compatJar, '/account');
  assert(`(I10) legacy JWT (no status claim) → /account reachable (got ${compatAcct.status})`,
    compatAcct.status === 200);
}

// ────────────────────────────────────────────────────────────── 4. STATIC AUDIT
function staticAuditTests() {
  console.log('\n── STATIC AUDIT — code-hygiene invariants ──');

  // (A1) 'dev-bypass-token' literal appears ONLY in:
  //   - the single-source-of-truth constants file (phoneConstants.ts)
  //   - the service module that imports + re-exports it
  //   - the route handler that uses it for the triple-guard check
  // Anywhere else risks a bypass leak.
  const ALLOW = new Set([
    'src/lib/auth/phoneConstants.ts',
    'src/lib/auth/phoneVerification.ts',
    'src/app/api/auth/phone/verify/route.ts',
  ]);
  const offenders1: string[] = [];
  for (const root of ['src']) {
    walk(root, (p) => {
      if (!/\.(ts|tsx)$/.test(p)) return;
      if (ALLOW.has(p)) return;
      const src = readFileSync(p, 'utf8');
      if (src.includes("'dev-bypass-token'") || src.includes('"dev-bypass-token"')) {
        // DEV_BYPASS_TOKEN import is fine — only the literal is forbidden.
        offenders1.push(p);
      }
    });
  }
  assert(`(A1) literal 'dev-bypass-token' only in allowed files (offenders: ${offenders1.length})`,
    offenders1.length === 0, offenders1);

  // (A2) No client component imports firebase-admin/* or 'firebase-admin'.
  const offenders2: string[] = [];
  for (const root of ['src']) {
    walk(root, (p) => {
      if (!/\.(ts|tsx)$/.test(p)) return;
      const src = readFileSync(p, 'utf8');
      const isClient = /^\s*['"]use client['"]/m.test(src);
      if (!isClient) return;
      if (/from\s+['"]firebase-admin(\/[^'"]*)?['"]/.test(src)
       || /require\s*\(\s*['"]firebase-admin(\/[^'"]*)?['"]\s*\)/.test(src)) {
        offenders2.push(p);
      }
    });
  }
  assert(`(A2) no client component imports firebase-admin (offenders: ${offenders2.length})`,
    offenders2.length === 0, offenders2);

  // (A3) `verifyIdToken` call appears ONLY inside firebasePhone.ts.
  //      (The existing firebase.ts email-mirror does not call it.)
  const offenders3: string[] = [];
  for (const root of ['src']) {
    walk(root, (p) => {
      if (!/\.(ts|tsx)$/.test(p)) return;
      if (p === 'src/lib/auth/firebasePhone.ts') return;
      const src = readFileSync(p, 'utf8');
      if (/\bverifyIdToken\s*\(/.test(src)) offenders3.push(p);
    });
  }
  assert(`(A3) verifyIdToken called only in firebasePhone.ts (offenders: ${offenders3.length})`,
    offenders3.length === 0, offenders3);

  // (A4) No window.alert/confirm/prompt in the new components. Quick
  //      defence-in-depth check (test:no-native-dialogs is the
  //      cross-file audit).
  const formSrc = readFileSync('src/components/auth/PhoneVerificationForm.tsx', 'utf8');
  assert('(A4) PhoneVerificationForm has no window.alert',   !/\bwindow\.alert\b/.test(formSrc));
  assert('(A4) PhoneVerificationForm has no window.confirm', !/\bwindow\.confirm\b/.test(formSrc));
  assert('(A4) PhoneVerificationForm has no window.prompt',  !/\bwindow\.prompt\b/.test(formSrc));

  // (A5) Service & verify route reference DEV_BYPASS_TOKEN (not raw string).
  const constants = readFileSync('src/lib/auth/phoneConstants.ts', 'utf8');
  assert('(A5) phoneConstants.ts defines the DEV_BYPASS_TOKEN literal',
    /export\s+const\s+DEV_BYPASS_TOKEN\s*=\s*['"]dev-bypass-token['"]/.test(constants));
  const svc = readFileSync('src/lib/auth/phoneVerification.ts', 'utf8');
  assert('(A5) phoneVerification.ts imports/re-exports DEV_BYPASS_TOKEN',
    /DEV_BYPASS_TOKEN/.test(svc));
  const rt = readFileSync('src/app/api/auth/phone/verify/route.ts', 'utf8');
  assert('(A5) verify route imports DEV_BYPASS_TOKEN', /DEV_BYPASS_TOKEN/.test(rt));
}

function walk(root: string, fn: (path: string) => void) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// ────────────────────────────────────────────────────────────── CLEANUP
async function cleanup() {
  console.log('\n── cleanup ──');
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TAG } }, select: { id: true },
  });
  for (const u of users) {
    await prisma.userActivity.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.auditLog.deleteMany({ where: { entity: 'User', entityId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    await prisma.otpCode.deleteMany({ where: { userId: u.id } });
    await prisma.address.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => { /* cascaded */ });
  }
  try { if (existsSync(OTP_FILE)) unlinkSync(OTP_FILE); } catch { /* */ }
  ok(`removed ${users.length} test user(s)`);
}

async function main() {
  try {
    unitTests();
    staticAuditTests();
    await serviceTests();
    await startServer();
    await integrationTests();
  } finally {
    await stopServer();
    try { await cleanup(); } catch (e) { console.warn('cleanup failed:', e); }
    await prisma.$disconnect();
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
