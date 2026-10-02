/**
 * Structured Logging — test suite.
 *
 *   npm run test:logging
 *
 * Four tiers:
 *
 *   1. UNIT — log shape, redaction rules, child logger, error handling
 *   2. SERVICE — AsyncLocalStorage requestId propagation
 *   3. INTEGRATION — real `next start`, real HTTP request, real log line
 *   4. STATIC AUDIT — zero `console.*` in src/lib + src/app/api (with
 *      a tiny allowlist for browser-only and bootstrap files), zero
 *      direct `process.stdout/stderr.write` outside the allowed files
 *
 * The unit + service tiers use a captured-stdout/stderr harness that
 * monkey-patches `process.stdout.write` / `process.stderr.write`
 * around each assertion and restores them in `finally`.
 */
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';

import { spawn, type ChildProcess } from 'node:child_process';
import {
  readdirSync, readFileSync, statSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

// We import the logger BEFORE doing anything else so its module-load
// cost doesn't pollute the first captured-write assertion.
import { log, newRequestId, runWithRequestContext } from '../src/lib/log';

// ── Harness ───────────────────────────────────────────────────────────────

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

/** Capture every write to stdout/stderr during `fn`. Returns the
 *  captured chunks (one per write call) for both streams.
 *
 *  CRITICAL: the harness MUST restore the original writers in `finally`
 *  — if we throw mid-capture we'd swallow every subsequent ok/fail line. */
async function captureIO<T>(
  fn: () => T | Promise<T>,
): Promise<{ stdout: string[]; stderr: string[]; result: T }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const stdout: string[] = [];
  const stderr: string[] = [];
  // The stream `.write` signature is overloaded; cast for the swap.
  (process.stdout as unknown as { write: (s: string) => boolean }).write =
    (s: string) => { stdout.push(String(s)); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write =
    (s: string) => { stderr.push(String(s)); return true; };
  try {
    const result = await fn();
    return { stdout, stderr, result };
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }
}

/** Parse the FIRST complete JSON object from a captured chunk string.
 *  Returns null if the chunk isn't JSON (won't happen for a healthy
 *  logger — the harness fails the asserting test directly). */
function parseLine(s: string): Record<string, unknown> | null {
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  try { return JSON.parse(trimmed) as Record<string, unknown>; }
  catch { return null; }
}

// ────────────────────────────────────────────────────────────── 1. UNIT
async function unitTests() {
  console.log('\n── UNIT — log shape, redaction, child, safety ──');

  // (U1) Basic shape on info.
  {
    const cap = await captureIO(() => log.info('test.basic', { userId: 'u1', amount: 100 }));
    eq('(U1) exactly one stdout write',  1, cap.stdout.length);
    eq('(U1) zero stderr writes',         0, cap.stderr.length);
    assert('(U1) ends with newline',      cap.stdout[0].endsWith('\n'));
    const line = parseLine(cap.stdout[0]);
    assert('(U1) is valid JSON', line !== null);
    if (!line) return;
    eq('(U1) level=info',     'info',         line.level);
    eq('(U1) msg=test.basic', 'test.basic',   line.msg);
    eq('(U1) env present',    process.env.NODE_ENV ?? 'development', line.env);
    eq('(U1) pid present',    process.pid,    line.pid);
    eq('(U1) userId echoed',  'u1',           line.userId);
    eq('(U1) amount echoed',  100,            line.amount);
    assert('(U1) ts is ISO string', typeof line.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(line.ts as string));
  }

  // (U2) warn/error route to stderr; debug/info to stdout.
  {
    const cap = await captureIO(() => {
      log.debug('test.debug');
      log.info('test.info');
      log.warn('test.warn');
      log.error('test.error');
    });
    eq('(U2) debug → stdout',  true, cap.stdout.some((l) => l.includes('"level":"debug"')));
    eq('(U2) info → stdout',   true, cap.stdout.some((l) => l.includes('"level":"info"')));
    eq('(U2) warn → stderr',   true, cap.stderr.some((l) => l.includes('"level":"warn"')));
    eq('(U2) error → stderr',  true, cap.stderr.some((l) => l.includes('"level":"error"')));
    eq('(U2) no warn on stdout',  false, cap.stdout.some((l) => l.includes('"level":"warn"')));
    eq('(U2) no error on stdout', false, cap.stdout.some((l) => l.includes('"level":"error"')));
  }

  // (U3) Full-redact: token / password / otp / idToken / firebasePhoneUid
  {
    const cap = await captureIO(() => log.info('test.redact_full', {
      password: 'hunter2',
      token: 'abc.def.ghi',
      otp: '123456',
      idToken: 'eyJhbGciOi...',
      firebasePhoneUid: 'fb-xyz',
      cookie: 'sc_session=...',
      authorization: 'Bearer X',
      utr: 'UPI123456789',
      receipt: '/path/to/file.pdf',
    }));
    const line = parseLine(cap.stdout[0])!;
    for (const k of ['password','token','otp','idToken','firebasePhoneUid','cookie','authorization','utr','receipt']) {
      eq(`(U3) ${k} = [REDACTED]`, '[REDACTED]', line[k]);
    }
  }

  // (U4) Mask-redact: email + phone variants
  {
    const cap = await captureIO(() => log.info('test.redact_mask', {
      email: 'katrina@example.com',
      phone: '+919876543210',
      phoneNumber: '+919876543210',
      mobile: '9876543210',
    }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U4) email keeps last 2 of local + full domain', '*****na@example.com', line.email);
    eq('(U4) +91 phone keeps +91 and last 4',            '+91******3210',       line.phone);
    eq('(U4) phoneNumber masked same way',               '+91******3210',       line.phoneNumber);
    eq('(U4) bare 10-digit mobile masked',               '******3210',          line.mobile);
  }

  // (U5) NEVER_REDACT: identifiers pass through unchanged
  {
    const cap = await captureIO(() => log.info('test.never_redact', {
      userId: 'u_abc', orderId: 'o_xyz', actorId: 'a_1',
      sessionId: 's_2', status: 'ACTIVE', role: 'CUSTOMER',
    }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U5) userId pass-through',  'u_abc',    line.userId);
    eq('(U5) orderId pass-through', 'o_xyz',    line.orderId);
    eq('(U5) actorId pass-through', 'a_1',      line.actorId);
    eq('(U5) status pass-through',  'ACTIVE',   line.status);
    eq('(U5) role pass-through',    'CUSTOMER', line.role);
  }

  // (U6) Nested redaction
  {
    const cap = await captureIO(() => log.info('test.nested', {
      payload: {
        before: { phone: '+919876543210', token: 'x' },
        after:  { items: [{ token: 'y', userId: 'u1' }] },
      },
    }));
    const line = parseLine(cap.stdout[0])!;
    const p = line.payload as { before: { phone: string; token: string };
      after: { items: { token: string; userId: string }[] } };
    eq('(U6) nested phone masked',     '+91******3210', p.before.phone);
    eq('(U6) nested token redacted',   '[REDACTED]',    p.before.token);
    eq('(U6) array item token redacted', '[REDACTED]',  p.after.items[0].token);
    eq('(U6) array item userId kept',  'u1',            p.after.items[0].userId);
  }

  // (U7) Case-insensitive key matching
  {
    const cap = await captureIO(() => log.info('test.case', {
      Password: 'x', PHONE: '+919876543210', IDToken: 'tok',
    }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U7) Password (caps) redacted',  '[REDACTED]',    line.Password);
    eq('(U7) PHONE (caps) masked',        '+91******3210', line.PHONE);
    eq('(U7) IDToken (caps) redacted',    '[REDACTED]',    line.IDToken);
  }

  // (U8) Caller cannot overwrite envelope fields (msg/level/ts/env/pid/requestId)
  {
    const cap = await captureIO(() => log.info('test.envelope', {
      msg:       'INJECTED',
      level:     'INJECTED',
      ts:        'INJECTED',
      env:       'INJECTED',
      pid:       'INJECTED',
      requestId: 'INJECTED',
    }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U8) msg not overridable',   'test.envelope', line.msg);
    eq('(U8) level not overridable', 'info',          line.level);
    assert('(U8) ts is real ISO',    typeof line.ts === 'string' && /^\d{4}-/.test(line.ts as string));
    eq('(U8) env not overridable',   process.env.NODE_ENV ?? 'development', line.env);
    eq('(U8) pid not overridable',   process.pid,     line.pid);
  }

  // (U9) Error instance is reshaped to {name,message,stack}
  {
    const cap = await captureIO(() => log.error('test.err_instance', { err: new Error('boom') }));
    const line = parseLine(cap.stderr[0])!;
    const err = line.err as { name: string; message: string; stack: string };
    eq('(U9) err.name = Error',          'Error', err.name);
    eq('(U9) err.message preserved',     'boom',  err.message);
    assert('(U9) err.stack non-empty',   typeof err.stack === 'string' && err.stack.length > 0);
  }

  // (U10) Circular object does NOT throw
  {
    const circ: Record<string, unknown> = { name: 'root' };
    circ.self = circ;
    const cap = await captureIO(() => log.info('test.circular', { circ }));
    eq('(U10) one stdout write produced (no throw)', 1, cap.stdout.length);
    const line = parseLine(cap.stdout[0])!;
    const c = line.circ as { name: string; self: string };
    eq('(U10) circular ref replaced by [Circular]', '[Circular]', c.self);
    eq('(U10) other fields preserved',              'root',       c.name);
  }

  // (U11) BigInt and Date handled
  {
    const cap = await captureIO(() => log.info('test.exotic', {
      big: BigInt('9007199254740993'),
      when: new Date('2026-01-01T00:00:00Z'),
    }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U11) BigInt serialised as string+n', '9007199254740993n', line.big);
    eq('(U11) Date serialised as ISO',         '2026-01-01T00:00:00.000Z', line.when);
  }

  // (U12) log.child() merges bindings AND does not mutate parent
  {
    const child = log.child({ orderId: 'o_child', userId: 'u_child' });
    const cap = await captureIO(() => {
      child.info('test.child_event', { amount: 999 });
      log.info('test.parent_event', { amount: 0 });
    });
    const childLine  = parseLine(cap.stdout[0])!;
    const parentLine = parseLine(cap.stdout[1])!;
    eq('(U12) child line has orderId binding', 'o_child', childLine.orderId);
    eq('(U12) child line has userId binding',  'u_child', childLine.userId);
    eq('(U12) child per-call amount echoed',   999,       childLine.amount);
    eq('(U12) parent line has NO orderId',     undefined, parentLine.orderId);
    eq('(U12) parent line has NO userId',      undefined, parentLine.userId);
  }

  // (U13) child(...).child(...) accumulates and per-call beats binding
  {
    const c2 = log.child({ a: 1 }).child({ b: 2, a: 'overridden_by_per_call?' });
    const cap = await captureIO(() => c2.info('test.nested_child', { a: 'PER_CALL' }));
    const line = parseLine(cap.stdout[0])!;
    eq('(U13) per-call wins over child binding', 'PER_CALL', line.a);
    eq('(U13) other child binding kept',          2,         line.b);
  }

  // (U14) NODE_ENV=test silences debug/info/warn but NOT error
  {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    try {
      const cap = await captureIO(() => {
        log.debug('silenced.debug');
        log.info('silenced.info');
        log.warn('silenced.warn');
        log.error('not.silenced.error');
      });
      eq('(U14) zero stdout writes in test mode', 0, cap.stdout.length);
      eq('(U14) exactly one stderr write (error)', 1, cap.stderr.length);
      assert('(U14) error line is for not.silenced.error',
        cap.stderr[0].includes('not.silenced.error'));
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  }

  // (U15) newRequestId() produces a stable-format id
  {
    const id = newRequestId();
    assert(`(U15) newRequestId looks valid (got "${id}")`, /^req_[a-f0-9]{8,}$/.test(id));
  }
}

// ────────────────────────────────────────────────────────────── 2. SERVICE
async function serviceTests() {
  console.log('\n── SERVICE — AsyncLocalStorage requestId propagation ──');

  // (R1) Inside runWithRequestContext, requestId is auto-attached
  {
    const cap = await captureIO(() => {
      return runWithRequestContext({ requestId: 'req_test_in' }, () => {
        log.info('inside.context');
      });
    });
    const line = parseLine(cap.stdout[0])!;
    eq('(R1) requestId attached inside scope', 'req_test_in', line.requestId);
  }

  // (R2) Outside any scope, requestId is OMITTED (not null, not undefined string)
  {
    const cap = await captureIO(() => log.info('outside.context'));
    const line = parseLine(cap.stdout[0])!;
    assert('(R2) requestId field absent outside scope',
      !Object.prototype.hasOwnProperty.call(line, 'requestId'),
      { lineKeys: Object.keys(line) });
  }

  // (R3) Context propagates across awaits
  {
    const cap = await captureIO(async () => {
      await runWithRequestContext({ requestId: 'req_async_x' }, async () => {
        await new Promise((r) => setImmediate(r));
        await Promise.resolve().then(() => log.info('after.await'));
      });
    });
    const line = parseLine(cap.stdout[0])!;
    eq('(R3) requestId survives async hops', 'req_async_x', line.requestId);
  }

  // (R4) Parallel contexts don't bleed
  {
    const cap = await captureIO(async () => {
      await Promise.all([
        runWithRequestContext({ requestId: 'req_A' }, async () => {
          await new Promise((r) => setImmediate(r));
          log.info('parallel.A');
        }),
        runWithRequestContext({ requestId: 'req_B' }, async () => {
          await new Promise((r) => setImmediate(r));
          log.info('parallel.B');
        }),
      ]);
    });
    const byMsg = new Map<string, Record<string, unknown>>();
    for (const chunk of cap.stdout) {
      const line = parseLine(chunk);
      if (line && typeof line.msg === 'string') byMsg.set(line.msg, line);
    }
    eq('(R4) parallel.A keeps req_A', 'req_A', byMsg.get('parallel.A')?.requestId);
    eq('(R4) parallel.B keeps req_B', 'req_B', byMsg.get('parallel.B')?.requestId);
  }

  // (R5) Request-store bindings merge into every log line in scope
  {
    const cap = await captureIO(() => {
      return runWithRequestContext(
        { requestId: 'req_bind', bindings: { tenant: 'main', traceId: 't1' } },
        () => log.info('bound.event', { x: 1 }),
      );
    });
    const line = parseLine(cap.stdout[0])!;
    eq('(R5) tenant binding merged', 'main', line.tenant);
    eq('(R5) traceId binding merged','t1',   line.traceId);
    eq('(R5) per-call x preserved',  1,      line.x);
    eq('(R5) requestId still attached', 'req_bind', line.requestId);
  }
}

// ────────────────────────────────────────────────────────────── 3. INTEGRATION
const PORT = 3051;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc: ChildProcess | null = null;
const SRV_LOG = `/tmp/test-logging-server-${process.pid}.log`;

async function startServer() {
  try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  serverProc = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' },
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
  const append = (b: Buffer) => writeFileSync(SRV_LOG, b, { flag: 'a' });
  serverProc.stdout?.on('data', append);
  serverProc.stderr?.on('data', append);
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

/** Read every JSON log line currently in the server log. */
function readServerLines(): Record<string, unknown>[] {
  if (!existsSync(SRV_LOG)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of readFileSync(SRV_LOG, 'utf8').split('\n')) {
    if (!raw.startsWith('{')) continue;
    try { out.push(JSON.parse(raw) as Record<string, unknown>); }
    catch { /* skip non-JSON lines (e.g. Next.js boot banner) */ }
  }
  return out;
}

async function integrationTests() {
  console.log('\n── INTEGRATION — real server, real HTTP request ──');

  // (I1) Hit a middleware-covered route; response header carries a fresh
  //      server-generated x-request-id. NOTE: as of edge-case fix D9.7 the
  //      middleware refuses to echo any inbound `x-request-id` header — that
  //      input is attacker-controllable and could be used for log injection.
  //      (The middleware matcher explicitly EXCLUDES /api/health + /api/ready
  //      to keep them probe-cheap, so they are NOT useful here. /api/auth/csrf
  //      goes through the full middleware stack.)
  // FIXED: was asserting the response echoed our attacker-supplied
  //        x-request-id verbatim — that was insecure (log-injection vector).
  //        Now asserts (a) the response *has* a request-id and (b) it is
  //        NOT the attacker-supplied value.
  const correlationId = `req_int_${crypto.randomBytes(4).toString('hex')}`;
  const res = await fetch(`${BASE}/api/auth/csrf`, {
    headers: { 'x-request-id': correlationId },
  });
  eq('(I1) /api/auth/csrf → 200', 200, res.status);
  const respReqId = res.headers.get('x-request-id');
  assert('(I1) response carries x-request-id header', !!respReqId && respReqId.length > 0,
    { respReqId });
  assert('(I1) response x-request-id is NOT the attacker-supplied value (D9.7)',
    respReqId !== correlationId, { respReqId, supplied: correlationId });

  // (I2) Trigger a CSRF rejection on a state-mutating route — confirms
  //      handleError() emits a structured WARN log with requestId.
  // FIXED: previously asserted the server log carried the *client-supplied*
  //        x-request-id. Post-D9.7 the server ignores inbound x-request-id
  //        and generates its own — so we now correlate via the request-id
  //        the server returns in the response header.
  const csrfRes = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const csrfServerReqId = csrfRes.headers.get('x-request-id') ?? '';
  assert('(I2) server response carried an x-request-id we can correlate with',
    csrfServerReqId.length > 0, { csrfServerReqId });
  // Allow the server stdio pipe to flush.
  await new Promise((r) => setTimeout(r, 500));
  const lines = readServerLines();
  // Find any line tagged with the server-assigned requestId.
  const csrfLines = lines.filter((l) => l.requestId === csrfServerReqId);
  assert(`(I2) at least one server log line carried server requestId (got ${csrfLines.length})`,
    csrfLines.length >= 1, { csrfServerReqId, recent: lines.slice(-5) });
  // The CSRF rejection should be logged as warn-level with api.csrf_rejected.
  assert('(I2) CSRF rejection emits api.csrf_rejected at warn',
    csrfLines.some((l) => l.msg === 'api.csrf_rejected' && l.level === 'warn'),
    { csrfLines });

  // (I3) Every JSON server log line is well-formed and carries env/pid.
  //      (We sample the most-recent 20 lines to keep the assertion cheap.)
  const recent = lines.slice(-20);
  assert('(I3) sample of ≥1 recent JSON log line exists', recent.length >= 1);
  for (const l of recent) {
    assert(`(I3) line has level (msg="${l.msg}")`, typeof l.level === 'string');
    assert(`(I3) line has msg`,                    typeof l.msg === 'string');
    assert(`(I3) line has ts`,                     typeof l.ts === 'string');
    assert(`(I3) line has env`,                    typeof l.env === 'string');
    assert(`(I3) line has pid`,                    typeof l.pid === 'number');
  }
}

// ────────────────────────────────────────────────────────────── 4. STATIC AUDIT
function staticAuditTests() {
  console.log('\n── STATIC AUDIT — no rogue console.* or direct stream writes ──');

  // Files allowed to contain `console.*`:
  //   - the logger itself (lib/log.ts) — references it in a comment + uses
  //     `console.log` nowhere; the audit's substring check is conservative.
  //   - browser-only `'use client'` modules: process.stdout doesn't exist
  //     in the browser, so the logger is moot there. We allow them by
  //     detecting the `'use client'` pragma at the top of the file.
  const ALLOW_CONSOLE = new Set<string>([
    'src/lib/log.ts',
    'src/lib/log/context.ts',
  ]);

  // Files allowed to call `process.{stdout,stderr}.write` directly:
  //   - the logger (the canonical writer)
  //   - config.ts (logs invalid-env at boot, BEFORE log.ts can safely
  //     be initialised; documented in-code).
  const ALLOW_STREAM_WRITE = new Set<string>([
    'src/lib/log.ts',
    'src/lib/log/context.ts',
    'src/lib/config.ts',
    // errors.ts hosts the process-level safety net which must emit a
    // fallback line BEFORE the logger can possibly be initialised
    // (e.g. an unhandledRejection during module-load). It uses
    // process.stderr.write only inside that fallback branch.
    'src/lib/errors.ts',
  ]);

  const offendersConsole: string[] = [];
  const offendersStream:  string[] = [];

  function walk(root: string, fn: (p: string) => void) {
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, fn);
      else fn(p);
    }
  }

  for (const root of ['src/lib', 'src/app/api']) {
    walk(root, (p) => {
      if (!/\.(ts|tsx)$/.test(p)) return;
      const src = readFileSync(p, 'utf8');
      const isClient = /^\s*['"]use client['"]/m.test(src);

      // console.* check (case-sensitive; matches actual calls only)
      if (!ALLOW_CONSOLE.has(p) && !isClient) {
        // Match a real method call, not a substring of a comment word.
        // We strip line/block comments first so doc text doesn't count.
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(stripped)) {
          offendersConsole.push(p);
        }
      }

      // process.stdout/stderr.write check (server files only — client
      // bundle would already fail at runtime if it hit these).
      if (!ALLOW_STREAM_WRITE.has(p) && !isClient) {
        if (/process\.(stdout|stderr)\.write\s*\(/.test(src)) {
          offendersStream.push(p);
        }
      }
    });
  }

  assert(`(A1) no rogue console.* (offenders: ${offendersConsole.length})`,
    offendersConsole.length === 0, offendersConsole);
  assert(`(A2) no direct process.{stdout,stderr}.write outside allowed files (offenders: ${offendersStream.length})`,
    offendersStream.length === 0, offendersStream);

  // (A3) The logger continues to export the documented public surface.
  const logSrc = readFileSync('src/lib/log.ts', 'utf8');
  assert('(A3) log.ts exports `log`',       /export\s+const\s+log\s*:/.test(logSrc));
  assert('(A3) log.ts exports `newRequestId`', /export\s+function\s+newRequestId/.test(logSrc));
  assert('(A3) log.ts re-exports runWithRequestContext',
    /export\s*\{[^}]*runWithRequestContext[^}]*\}\s*from\s*['"]@\/lib\/log\/context['"]/.test(logSrc));
}

// ────────────────────────────────────────────────────────────── MAIN
async function main() {
  try {
    await unitTests();
    await serviceTests();
    staticAuditTests();
    await startServer();
    await integrationTests();
  } finally {
    await stopServer();
    try { if (existsSync(SRV_LOG)) unlinkSync(SRV_LOG); } catch { /* */ }
  }
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  process.exit(1);
});
