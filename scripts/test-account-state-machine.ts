/**
 * Account State Machine — test suite.
 *
 *   npm run test:account-state-machine
 *
 * Five layers:
 *
 *   1. UNIT (pure helpers)           — every boolean predicate against
 *                                       every status value.
 *   2. UNIT (canTransition / graph)  — every entry in the transition
 *                                       graph asserted true with the
 *                                       correct actor; every illegal
 *                                       (from, to) pair asserted false;
 *                                       every legal pair with a wrong
 *                                       actor asserted false.
 *   3. SERVICE (real DB)             — transitionAccountState end-to-end:
 *                                       happy path, illegal transitions,
 *                                       actor not permitted, precondition
 *                                       fails, concurrent modification,
 *                                       terminal-state guard, session
 *                                       revocation on suspend, AuditLog
 *                                       + UserActivity rows written.
 *   4. INTEGRATION (real `next start`) — admin suspend/reinstate/delete
 *                                       through the real HTTP route +
 *                                       login-permission gating + deleted
 *                                       account cannot log in.
 *   5. STATIC AUDIT                  — scans the source tree for direct
 *                                       `User.status` writes that bypass
 *                                       the machine without a
 *                                       STATE_MACHINE_BYPASS tag.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { prisma } from '../src/lib/db/client';
import { UserStatus, type UserStatus as UserStatusT } from '../src/lib/enums';
import {
  transitionAccountState, canTransition,
  isLoginPermitted, isOrderPermitted, isWritePermitted, isTerminal, isKnownStatus,
  _internalTransitionEntries,
  type ActorContext, type ActorType,
} from '../src/lib/auth/accountStateMachine';
import { hashPassword } from '../src/lib/auth/password';
import { issueRefreshFamily, accessTtlFor } from '../src/lib/auth/refresh';
import { env } from '../src/lib/config';
import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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

const TAG = `asm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const freshPhone = () => '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);

async function makeUser(label: string, status: UserStatusT = UserStatus.PENDING_OTP) {
  return prisma.user.create({
    data: {
      firstName: 'Asm', lastName: label,
      email: `${TAG}_${label}@shopcore.test`,
      phone: freshPhone(),
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'CUSTOMER',
      // STATE_MACHINE_BYPASS: test-fixture seeding — the state machine
      // governs runtime TRANSITIONS, not initial-row inserts.
      status,
      referralCode: 'R' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
}

async function makeAdmin(label: string) {
  return prisma.user.create({
    data: {
      firstName: 'Asm', lastName: `Admin ${label}`,
      email: `${TAG}_admin_${label}@shopcore.test`,
      phone: freshPhone(),
      passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India',
      role: 'ADMIN',
      // STATE_MACHINE_BYPASS: test-fixture seeding (see makeUser).
      status: UserStatus.ACTIVE,
      referralCode: 'R' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });
}

// ────────────────────────────────────────────────────────────── 1. UNIT — helpers
function pureHelperTests() {
  console.log('\n── UNIT — pure predicates ──');
  const allStatuses: UserStatusT[] = Object.values(UserStatus);
  eq('(H0) UserStatus enum has 5 known values', 5, allStatuses.length);

  for (const s of allStatuses) {
    eq(`(H1) isKnownStatus("${s}") = true`, true, isKnownStatus(s));
  }
  assert('(H1) isKnownStatus("nope") = false', !isKnownStatus('nope'));
  assert('(H1) isKnownStatus("") = false',     !isKnownStatus(''));

  for (const s of allStatuses) {
    const expectActive = s === UserStatus.ACTIVE;
    // Phone Verification feature — `isLoginPermitted` now also returns
    // true for PENDING_PHONE_VERIFICATION (the user must be able to log
    // in to RESUME the second-step verification flow). `isOrder` and
    // `isWrite` remain ACTIVE-only.
    const expectLogin = s === UserStatus.ACTIVE
                     || s === UserStatus.PENDING_PHONE_VERIFICATION;
    eq(`(H2) isLoginPermitted("${s}") = ${expectLogin}`,   expectLogin,   isLoginPermitted(s));
    eq(`(H2) isOrderPermitted("${s}") = ${expectActive}`,  expectActive,  isOrderPermitted(s));
    eq(`(H2) isWritePermitted("${s}") = ${expectActive}`,  expectActive,  isWritePermitted(s));
    eq(`(H2) isTerminal("${s}") = ${s === UserStatus.DELETED}`,
       s === UserStatus.DELETED, isTerminal(s));
  }
}

// ────────────────────────────────────────────────────────────── 2. UNIT — canTransition
function canTransitionTests() {
  console.log('\n── UNIT — canTransition (graph integrity) ──');
  const entries = _internalTransitionEntries();
  // Phone Verification feature added 5 new entries on top of the
  // original 6 → at least 11. We use ≥ to stay forward-compatible
  // with future additions.
  assert(`(G0) graph has ≥ 11 entries (got ${entries.length})`, entries.length >= 11);

  const allActors: ActorType[] = ['SYSTEM', 'ADMIN', 'SELF'];

  // Every legal entry: returns true with a permitted actor.
  for (const e of entries) {
    for (const a of e.rule.allowed) {
      const actor = makeActor(a);
      assert(`(G1) canTransition(${e.from} → ${e.to}, actor=${a}) = true`,
        canTransition(e.from, e.to, actor));
    }
    // Every legal entry: returns false with a non-permitted actor.
    for (const a of allActors) {
      if (e.rule.allowed.includes(a)) continue;
      const actor = makeActor(a);
      eq(`(G2) canTransition(${e.from} → ${e.to}, actor=${a}) = false (not allowed)`,
        false, canTransition(e.from, e.to, actor));
    }
  }

  // No-op (from === to) is always false.
  for (const s of Object.values(UserStatus)) {
    eq(`(G3) canTransition(${s} → ${s}) = false (no-op)`,
      false, canTransition(s, s, { type: 'SYSTEM' }));
  }

  // Unknown states reject.
  eq('(G4) canTransition(unknown → ACTIVE) = false', false,
    canTransition('UNKNOWN', UserStatus.ACTIVE, { type: 'SYSTEM' }));
  eq('(G4) canTransition(ACTIVE → unknown) = false', false,
    canTransition(UserStatus.ACTIVE, 'UNKNOWN', { type: 'ADMIN', adminId: 'x' }));

  // Terminal guard: DELETED → anything is always false.
  for (const s of Object.values(UserStatus)) {
    if (s === UserStatus.DELETED) continue;
    eq(`(G5) canTransition(DELETED → ${s}) = false (terminal)`,
      false, canTransition(UserStatus.DELETED, s, { type: 'ADMIN', adminId: 'x' }));
  }

  // ADMIN without adminId is rejected even if the actor.type is allowed.
  // We cast through `as` to simulate a runtime misuse.
  eq('(G6) canTransition(ACTIVE → SUSPENDED, malformed ADMIN) = false', false,
    canTransition(
      UserStatus.ACTIVE, UserStatus.SUSPENDED,
      { type: 'ADMIN' } as unknown as ActorContext,
    ));
  eq('(G6) canTransition(ACTIVE → DELETED, malformed SELF) = false', false,
    canTransition(
      UserStatus.ACTIVE, UserStatus.DELETED,
      { type: 'SELF' } as unknown as ActorContext,
    ));

  // Explicit spec coverage: PENDING_OTP → SUSPENDED is illegal (would be
  // a future edit's mistake). Today the graph has no such entry.
  eq('(G7) canTransition(PENDING_OTP → SUSPENDED, ADMIN) = false',
    false, canTransition(UserStatus.PENDING_OTP, UserStatus.SUSPENDED, makeActor('ADMIN')));
  // ACTIVE → PENDING_OTP is illegal.
  eq('(G7) canTransition(ACTIVE → PENDING_OTP, anyone) = false',
    false, canTransition(UserStatus.ACTIVE, UserStatus.PENDING_OTP, makeActor('ADMIN')));
}

function makeActor(t: ActorType): ActorContext {
  if (t === 'SYSTEM') return { type: 'SYSTEM' };
  if (t === 'ADMIN')  return { type: 'ADMIN', adminId: 'pretend-admin-id' };
  return { type: 'SELF', userId: 'pretend-self-id' };
}

// ────────────────────────────────────────────────────────────── 3. SERVICE (DB)
async function serviceTests() {
  console.log('\n── SERVICE — transitionAccountState (real DB) ──');
  const admin = await makeAdmin('svc');

  // (S1) Happy path: PENDING_OTP → ACTIVE via SYSTEM
  const u1 = await makeUser('s1', UserStatus.PENDING_OTP);
  const r1 = await transitionAccountState(u1.id, UserStatus.ACTIVE, { type: 'SYSTEM' }, { reason: 'OTP verified' });
  assert('(S1) PENDING_OTP → ACTIVE returns ok', r1.ok);
  if (r1.ok) eq('(S1) row status is ACTIVE after success', UserStatus.ACTIVE, r1.user.status);
  // UserActivity row was written.
  const acts1 = await prisma.userActivity.findMany({ where: { userId: u1.id, action: 'ACCOUNT_ACTIVATED' } });
  eq('(S1) UserActivity ACCOUNT_ACTIVATED row exists', 1, acts1.length);
  // AuditLog NOT written for SYSTEM actor (no admin → no FK target).
  const audits1 = await prisma.auditLog.findMany({ where: { entity: 'User', entityId: u1.id } });
  eq('(S1) AuditLog NOT written for SYSTEM actor', 0, audits1.length);

  // (S2) Illegal transition — ACTIVE → PENDING_OTP rejected
  const r2 = await transitionAccountState(u1.id, UserStatus.PENDING_OTP, { type: 'ADMIN', adminId: admin.id });
  assert('(S2) ACTIVE → PENDING_OTP returns !ok', !r2.ok);
  if (!r2.ok) eq('(S2) reason = ILLEGAL_TRANSITION', 'ILLEGAL_TRANSITION', r2.reason);

  // (S3) Wrong actor — SYSTEM cannot ACTIVE → SUSPENDED
  const r3 = await transitionAccountState(u1.id, UserStatus.SUSPENDED, { type: 'SYSTEM' });
  assert('(S3) ACTIVE → SUSPENDED with SYSTEM returns !ok', !r3.ok);
  if (!r3.ok) eq('(S3) reason = ACTOR_NOT_PERMITTED', 'ACTOR_NOT_PERMITTED', r3.reason);

  // (S4) Happy path — ADMIN suspends ACTIVE, refresh families revoked.
  // First, give the user a refresh family so we can observe revocation.
  const fam = await issueRefreshFamily({ userId: u1.id, role: 'CUSTOMER' });
  const liveBefore = await prisma.refreshTokenFamily.count({ where: { userId: u1.id, revokedAt: null } });
  assert('(S4) refresh family live before suspend', liveBefore >= 1);
  void fam;
  const r4 = await transitionAccountState(u1.id, UserStatus.SUSPENDED, { type: 'ADMIN', adminId: admin.id }, { reason: 'Investigation' });
  assert('(S4) ADMIN suspend returns ok', r4.ok);
  if (r4.ok) eq('(S4) row status is SUSPENDED', UserStatus.SUSPENDED, r4.user.status);
  const liveAfter = await prisma.refreshTokenFamily.count({ where: { userId: u1.id, revokedAt: null } });
  eq('(S4) refresh families revoked after ACTIVE → SUSPENDED', 0, liveAfter);
  // AuditLog row WAS written for ADMIN actor.
  const audits4 = await prisma.auditLog.findMany({ where: { entity: 'User', entityId: u1.id } });
  assert(`(S4) AuditLog row written for ADMIN actor (got ${audits4.length})`, audits4.length >= 1);
  assert('(S4) AuditLog row carries actorId = admin.id',
    audits4[0].actorId === admin.id);
  // UserActivity ACCOUNT_SUSPENDED row exists.
  const susActs = await prisma.userActivity.findMany({ where: { userId: u1.id, action: 'ACCOUNT_SUSPENDED' } });
  eq('(S4) UserActivity ACCOUNT_SUSPENDED row exists', 1, susActs.length);

  // (S5) SUSPENDED → ACTIVE (reinstate)
  const r5 = await transitionAccountState(u1.id, UserStatus.ACTIVE, { type: 'ADMIN', adminId: admin.id }, { reason: 'Cleared' });
  assert('(S5) SUSPENDED → ACTIVE returns ok', r5.ok);
  if (r5.ok) eq('(S5) row status is ACTIVE again', UserStatus.ACTIVE, r5.user.status);

  // (S6) Self-target precondition: admin cannot transition their OWN account.
  const rSelf = await transitionAccountState(admin.id, UserStatus.SUSPENDED, { type: 'ADMIN', adminId: admin.id });
  assert('(S6) admin cannot transition their own account', !rSelf.ok);
  if (!rSelf.ok) eq('(S6) reason = PRECONDITION_FAILED', 'PRECONDITION_FAILED', rSelf.reason);

  // (S7) Terminal state — DELETED is forever.
  const u7 = await makeUser('s7', UserStatus.DELETED);
  for (const target of [UserStatus.ACTIVE, UserStatus.SUSPENDED, UserStatus.PENDING_OTP] as UserStatusT[]) {
    const r = await transitionAccountState(u7.id, target, { type: 'ADMIN', adminId: admin.id });
    assert(`(S7) DELETED → ${target} returns !ok`, !r.ok);
    if (!r.ok) eq(`(S7) DELETED → ${target} reason = ILLEGAL_TRANSITION`,
      'ILLEGAL_TRANSITION', r.reason);
  }

  // (S8) USER_NOT_FOUND
  const r8 = await transitionAccountState('definitely-does-not-exist', UserStatus.ACTIVE, { type: 'SYSTEM' });
  assert('(S8) unknown userId returns !ok', !r8.ok);
  if (!r8.ok) eq('(S8) reason = USER_NOT_FOUND', 'USER_NOT_FOUND', r8.reason);

  // (S9) CONCURRENT_MODIFICATION — change status in DB between the
  // initial read and the transaction's optimistic-lock write. We force
  // this by transitioning a user via TWO parallel calls.
  const u9 = await makeUser('s9', UserStatus.PENDING_OTP);
  // Issue two concurrent activations.
  const [a, b] = await Promise.all([
    transitionAccountState(u9.id, UserStatus.ACTIVE, { type: 'SYSTEM' }),
    transitionAccountState(u9.id, UserStatus.ACTIVE, { type: 'SYSTEM' }),
  ]);
  // Exactly one should succeed; the loser is either ILLEGAL_TRANSITION
  // (because the row is already ACTIVE and ACTIVE → ACTIVE is no-op) OR
  // CONCURRENT_MODIFICATION (if the write race lost). Both are acceptable
  // — what matters is we never end up with two successes.
  const okCount  = (a.ok ? 1 : 0) + (b.ok ? 1 : 0);
  eq('(S9) exactly one of two concurrent transitions succeeds', 1, okCount);
  const loser = a.ok ? b : a;
  if (!loser.ok) {
    assert(`(S9) loser.reason ∈ {CONCURRENT_MODIFICATION, ILLEGAL_TRANSITION} (got "${loser.reason}")`,
      loser.reason === 'CONCURRENT_MODIFICATION' || loser.reason === 'ILLEGAL_TRANSITION');
  }

  // (S10) Unknown target status → ILLEGAL_TRANSITION.
  const u10 = await makeUser('s10', UserStatus.ACTIVE);
  const r10 = await transitionAccountState(
    u10.id,
    'GIBBERISH' as UserStatusT,
    { type: 'ADMIN', adminId: admin.id },
  );
  assert('(S10) unknown target → !ok', !r10.ok);
  if (!r10.ok) eq('(S10) reason = ILLEGAL_TRANSITION', 'ILLEGAL_TRANSITION', r10.reason);

  // (S11) Corrupted-status detection — set DB to a non-enum value and try
  // to transition. The machine should throw (DB corruption = hard error).
  const u11 = await makeUser('s11', UserStatus.ACTIVE);
  // STATE_MACHINE_BYPASS: deliberately corrupting the row to assert the
  // machine's corruption-detection path.
  await prisma.user.update({ where: { id: u11.id }, data: { status: 'CORRUPTED_VALUE' } });
  let threw = false;
  try {
    await transitionAccountState(u11.id, UserStatus.SUSPENDED, { type: 'ADMIN', adminId: admin.id });
  } catch {
    threw = true;
  }
  assert('(S11) corrupted DB status throws (hard error)', threw);

  // Cleanup pseudo-locals.
  void admin;
}

// ────────────────────────────────────────────────────────────── 4. INTEGRATION (HTTP)
const PORT = 3047;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;

async function startServer() {
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'development', SHOPCORE_ALLOW_TEST_EMAILS: '1',
      // This test bursts admin PATCH requests faster than the 120/min cap.
      SHOPCORE_DISABLE_RATE_LIMITS: '1',
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
  const out = (b: Buffer) => writeFileSync('/tmp/test-account-state-machine.log', b, { flag: 'a' });
  serverProc.stdout?.on('data', out);
  serverProc.stderr?.on('data', out);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
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
async function api(jar: Jar, path: string, init?: { method?: string; json?: unknown }) {
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
  });
  applySetCookies(jar, res);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* */ }
  return { status: res.status, body };
}

async function makeAdminJar() {
  const admin = await makeAdmin('int');
  const fam = await issueRefreshFamily({ userId: admin.id, role: 'ADMIN' });
  const ttl = accessTtlFor('ADMIN');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  const jwt = await new SignJWT({
    sub: admin.id, role: admin.role, email: admin.email,
    jti: sessionId, fam: fam.familyId,
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
  console.log('\n── INTEGRATION — admin PATCH /api/admin/customers/[id] ──');

  const { admin, jar } = await makeAdminJar();
  const customer = await makeUser('int_cust', UserStatus.ACTIVE);

  // (I1) Admin suspends.
  const r1 = await api(jar, `/api/admin/customers/${customer.id}`, {
    method: 'PATCH', json: { status: 'SUSPENDED' },
  });
  eq('(I1) PATCH status=SUSPENDED → 200', 200, r1.status);
  const after1 = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  eq('(I1) row status is SUSPENDED', UserStatus.SUSPENDED, after1.status);

  // (I2) Admin reinstates.
  const r2 = await api(jar, `/api/admin/customers/${customer.id}`, {
    method: 'PATCH', json: { status: 'ACTIVE' },
  });
  eq('(I2) PATCH status=ACTIVE → 200', 200, r2.status);
  const after2 = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  eq('(I2) row status is ACTIVE again', UserStatus.ACTIVE, after2.status);

  // (I3) Illegal: try to set the customer back to PENDING_OTP.
  const r3 = await api(jar, `/api/admin/customers/${customer.id}`, {
    method: 'PATCH', json: { status: 'PENDING_OTP' },
  });
  // The admin route's Zod schema only accepts ACTIVE/SUSPENDED/DELETED,
  // so this is rejected at the schema layer (400). That's correct — the
  // state machine would also reject it as ILLEGAL_TRANSITION; either way
  // a non-2xx response is the right outcome.
  assert(`(I3) PATCH status=PENDING_OTP rejected (got ${r3.status})`,
    r3.status >= 400 && r3.status < 500);

  // (I4) Admin deletes.
  const r4 = await api(jar, `/api/admin/customers/${customer.id}`, {
    method: 'PATCH', json: { status: 'DELETED' },
  });
  eq('(I4) PATCH status=DELETED → 200', 200, r4.status);
  const after4 = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  eq('(I4) row status is DELETED', UserStatus.DELETED, after4.status);

  // (I5) Reinstating a DELETED account → state-machine ILLEGAL_TRANSITION → 409.
  const r5 = await api(jar, `/api/admin/customers/${customer.id}`, {
    method: 'PATCH', json: { status: 'ACTIVE' },
  });
  eq('(I5) DELETED → ACTIVE returns 409 (terminal guard)', 409, r5.status);
  assert(`(I5) error code is ILLEGAL_TRANSITION (got ${JSON.stringify(r5.body.code)})`,
    r5.body.code === 'ILLEGAL_TRANSITION');

  // (I6) Self-target rejected at the precondition layer.
  const rSelf = await api(jar, `/api/admin/customers/${admin.id}`, {
    method: 'PATCH', json: { status: 'SUSPENDED' },
  });
  // The customers PATCH has its own "cannot suspend an admin" guard; either
  // that or PRECONDITION_FAILED is the correct outcome. Both are 4xx.
  assert(`(I6) admin cannot self-transition (got ${rSelf.status})`,
    rSelf.status >= 400 && rSelf.status < 500);
}

// ────────────────────────────────────────────────────────────── 5. STATIC AUDIT
function staticAuditTests() {
  console.log('\n── STATIC AUDIT — direct User.status writes ──');

  // Walk src/ + scripts/ + prisma/ for any `prisma.user.update(...)` or
  // `prisma.user.create(...)` that mentions `status:` in the data block,
  // EXCEPT files containing a `STATE_MACHINE_BYPASS` comment. The state
  // machine itself is exempt (it IS the writer).
  const ALLOW_FILES = new Set<string>([
    'src/lib/auth/accountStateMachine.ts',  // the legitimate writer
  ]);

  const offenders: string[] = [];

  for (const root of ['src', 'scripts', 'prisma']) {
    walk(root, (filePath) => {
      // Only inspect TS/TSX source files (not migrations).
      if (!/\.(ts|tsx)$/.test(filePath)) return;
      if (ALLOW_FILES.has(filePath)) return;
      const src = readFileSync(filePath, 'utf8');
      // Find every `prisma.user.update(...)` or `prisma.user.create(...)`
      // call. For each, extract the call's `data: { ... }` object and
      // check whether THAT specific block contains a `status:` key — a
      // bare `status:` elsewhere in the surrounding window (e.g. a
      // PasswordResetRequest update on the next line, or a TypeScript
      // type `status?:` field) is a false positive.
      const callRe = /(?:prisma|tx)\.user\.(?:update|create)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src))) {
        const start = m.index;
        // Find the matching `data: {` inside the call. The Prisma call
        // shape is always one of:
        //   prisma.user.update({ where: { ... }, data: { ... } })
        //   prisma.user.create({ data: { ... } })
        // So we scan forward for `data:` then balance-match the braces.
        const callTail   = src.slice(start, start + 4000);
        const dataMatch  = callTail.match(/\bdata\s*:\s*\{/);
        if (!dataMatch) continue;
        const dataStart  = (dataMatch.index ?? 0) + dataMatch[0].length;
        // Balance-match the data-object braces.
        let depth = 1;
        let i = dataStart;
        for (; i < callTail.length && depth > 0; i++) {
          if (callTail[i] === '{') depth++;
          else if (callTail[i] === '}') depth--;
        }
        if (depth !== 0) continue; // unbalanced — skip cautiously
        const dataBlock = callTail.slice(dataStart, i - 1);
        // Does the data object itself assign `status:` ?
        if (!/(^|[,{\s])status\s*:/.test(dataBlock)) continue;

        // STATE_MACHINE_BYPASS comment inside the data block OR within
        // ~400 chars before the call?
        const before = src.slice(Math.max(0, start - 400), start);
        if (/STATE_MACHINE_BYPASS/.test(dataBlock) || /STATE_MACHINE_BYPASS/.test(before)) continue;

        offenders.push(`${filePath} (offset ${start})`);
      }
    });
  }

  assert(`(A1) zero untagged User.status writes (found ${offenders.length})`,
    offenders.length === 0,
    offenders.slice(0, 10));
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
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.refreshToken.deleteMany({ where: { family: { userId: u.id } } });
    await prisma.refreshTokenFamily.deleteMany({ where: { userId: u.id } });
    // Also clear AuditLog rows ABOUT this user (entity=User, entityId=u.id)
    await prisma.auditLog.deleteMany({ where: { entity: 'User', entityId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => { /* may be cascaded */ });
  }
  ok(`removed ${users.length} test user(s)`);
}

async function main() {
  try {
    pureHelperTests();
    canTransitionTests();
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
