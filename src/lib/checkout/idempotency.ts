/**
 * Idempotency helper for write endpoints.
 *
 * Contract:
 *   - Caller passes (userId, key, fingerprint, endpoint, ttlSeconds, work).
 *   - We INSERT a `PROCESSING` row keyed by UNIQUE(userId, key). The DB
 *     constraint is what guarantees "exactly once" — even under concurrent
 *     submissions or multiple server processes.
 *   - If the INSERT succeeds, we run `work()`, persist its result, and return.
 *   - If the INSERT trips the UNIQUE constraint, we have a duplicate. We then:
 *       (a) validate the fingerprint matches; else 409 (key reused with a
 *           different payload — programming error / replay attack).
 *       (b) if the existing row is SUCCEEDED or FAILED, return the cached
 *           response immediately ("you've already done this; here's what
 *           happened").
 *       (c) if the existing row is PROCESSING (a concurrent in-flight
 *           request), poll briefly until it transitions or times out (we
 *           treat a too-long PROCESSING as a hung first request and surface
 *           a 409 so the client can decide what to do).
 *
 * Status lifecycle:  PROCESSING → SUCCEEDED | FAILED.
 *
 * Notes:
 *  - All errors that escape `work()` are caught and persisted as FAILED so a
 *    retry sees the same failure (no flapping outcomes from the user's POV).
 *  - Records auto-expire after `ttlSeconds` (default 24h) and the daily
 *    backup cron prunes them.
 *  - The helper is endpoint-agnostic: it can wrap any POST mutation, not
 *    just checkout.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import type { Prisma } from '@prisma/client';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Validate the header value: RFC 4122-ish UUID OR a long opaque token. */
export function isValidIdempotencyKey(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length < 16 || s.length > 128) return false;
  // allow UUIDs or url-safe base64 / hex tokens
  return /^[A-Za-z0-9_.:-]+$/.test(s);
}

/**
 * Build a stable fingerprint of the request that determines the outcome.
 * Two requests with the same fingerprint MUST produce the same result;
 * two requests with different fingerprints but the same key are a conflict.
 *
 * We sort keys + stringify with a stable representation, then sha256.
 */
export function fingerprintRequest(input: unknown): string {
  const stable = stableStringify(input);
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

export type IdempotencyOutcome<T> =
  | { kind: 'fresh';     status: number; body: T }                 // we just ran it
  | { kind: 'replay';    status: number; body: T; orderId: string | null } // cached hit
  | { kind: 'conflict';  reason: string }                          // key reused w/ different payload, or PROCESSING timeout
  | { kind: 'malformed'; reason: string };                         // bad header

const STATUS = {
  PROCESSING: 'PROCESSING',
  SUCCEEDED:  'SUCCEEDED',
  FAILED:     'FAILED',
} as const;

export interface WithIdempotencyOptions<T> {
  userId: string;
  key: string;
  endpoint: string;
  fingerprint: string;
  ttlSeconds?: number;            // default 86_400
  maxPollMs?: number;             // how long to wait on a sibling in-flight; default 8000
  pollIntervalMs?: number;        // default 250
  work: () => Promise<{ status: number; body: T; orderId?: string | null }>;
}

/**
 * Wrap a write operation so it executes AT MOST ONCE per (userId, key).
 * Subsequent identical retries get the same response.
 */
export async function withIdempotency<T>(opts: WithIdempotencyOptions<T>): Promise<IdempotencyOutcome<T>> {
  const ttl = opts.ttlSeconds ?? 86_400;
  const maxPoll = opts.maxPollMs ?? 8_000;
  const pollInterval = opts.pollIntervalMs ?? 250;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  if (!isValidIdempotencyKey(opts.key)) {
    return { kind: 'malformed', reason: 'Idempotency-Key must be 16–128 chars of [A-Za-z0-9_.:-].' };
  }

  // 1. Try to claim the slot. The UNIQUE constraint is the only race-safety
  //    primitive we need — DB serialises the INSERT.
  let claimed = false;
  try {
    await prisma.idempotencyKey.create({
      data: {
        userId: opts.userId, key: opts.key, endpoint: opts.endpoint,
        status: STATUS.PROCESSING, requestFingerprint: opts.fingerprint,
        expiresAt,
      },
    });
    claimed = true;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  if (claimed) {
    // We own the slot. Run the work, persist outcome, return.
    try {
      const result = await opts.work();
      await prisma.idempotencyKey.update({
        where: { userId_key: { userId: opts.userId, key: opts.key } },
        data: {
          status: STATUS.SUCCEEDED,
          resultStatus: result.status,
          resultBody: JSON.stringify(result.body),
          resultOrderId: result.orderId ?? null,
        },
      });
      return { kind: 'fresh', status: result.status, body: result.body };
    } catch (err) {
      // Persist failure so retries see the SAME outcome (deterministic).
      const body = { ok: false, error: (err as Error).message ?? 'Internal error.' };
      await prisma.idempotencyKey.update({
        where: { userId_key: { userId: opts.userId, key: opts.key } },
        data: {
          status: STATUS.FAILED,
          resultStatus: 500,
          resultBody: JSON.stringify(body),
        },
      });
      log.error('idempotency.work_failed', { userId: opts.userId, key: opts.key, endpoint: opts.endpoint, err: (err as Error).message });
      return { kind: 'fresh', status: 500, body: body as unknown as T };
    }
  }

  // 2. Someone else claimed the slot. Find the existing row.
  const existing = await prisma.idempotencyKey.findUnique({
    where: { userId_key: { userId: opts.userId, key: opts.key } },
  });
  if (!existing) {
    // Vanishingly rare race: claimed by us, deleted, then we lost the row.
    return { kind: 'conflict', reason: 'Idempotency record disappeared; please retry with a new key.' };
  }

  // 3. Same key but different request payload? That's a conflict.
  if (existing.requestFingerprint !== opts.fingerprint) {
    log.warn('idempotency.fingerprint_conflict', {
      userId: opts.userId, key: opts.key, endpoint: opts.endpoint,
    });
    return { kind: 'conflict', reason: 'Idempotency-Key was already used with a different request payload.' };
  }

  // 4. Already finished? Return the cached outcome.
  if (existing.status === STATUS.SUCCEEDED || existing.status === STATUS.FAILED) {
    return {
      kind: 'replay',
      status: existing.resultStatus ?? 200,
      body: existing.resultBody ? JSON.parse(existing.resultBody) as T : (null as unknown as T),
      orderId: existing.resultOrderId,
    };
  }

  // 5. Still PROCESSING — poll the row, waiting for the sibling to finish.
  const deadline = Date.now() + maxPoll;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const row = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId: opts.userId, key: opts.key } },
    });
    if (!row) {
      return { kind: 'conflict', reason: 'Idempotency record disappeared mid-poll.' };
    }
    if (row.status === STATUS.SUCCEEDED || row.status === STATUS.FAILED) {
      return {
        kind: 'replay',
        status: row.resultStatus ?? 200,
        body: row.resultBody ? JSON.parse(row.resultBody) as T : (null as unknown as T),
        orderId: row.resultOrderId,
      };
    }
  }

  // 6. Sibling never finished within the poll window. Don't double-execute —
  //    surface a 409 and let the operator / client decide.
  return { kind: 'conflict', reason: 'A concurrent request with the same Idempotency-Key is still processing; retry shortly.' };
}

function isUniqueViolation(e: unknown): boolean {
  // Prisma maps SQLite UNIQUE failures to P2002
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'P2002';
}

/** Manual cleanup used by the daily cron (`scripts/backup.ts` calls this). */
export async function pruneExpiredIdempotencyKeys(now: Date = new Date()): Promise<number> {
  const r = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}

/** Internal type guard so route handlers can stay tidy. */
export function asIdempotencyKeyHeader(headers: Headers): string | null {
  return headers.get(IDEMPOTENCY_HEADER) ?? headers.get('x-idempotency-key') ?? null;
}

/** Prisma `where` for the composite unique — exported for tests. */
export const idemWhere = (userId: string, key: string): Prisma.IdempotencyKeyWhereUniqueInput =>
  ({ userId_key: { userId, key } });
