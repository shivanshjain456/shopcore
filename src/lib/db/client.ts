/**
 * Prisma client singleton.
 *
 * Why a singleton: Next.js hot-reloads in dev re-evaluate modules, which would
 * create dozens of Prisma instances and exhaust SQLite connections.
 */
import { PrismaClient } from '@prisma/client';
import { registerProcessErrorHandlers } from '@/lib/errors';

declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

// This module is imported by every service + route handler that touches
// the DB — i.e. very early in any request lifecycle. That makes it a
// reliable single hook for registering the process-wide unhandled-
// rejection + uncaught-exception listeners.
//
// The registration is idempotent (a global Symbol flag inside
// `registerProcessErrorHandlers`), so re-running on hot-reload is safe.
registerProcessErrorHandlers();

// Default transaction options are tuned for the heaviest hot-path: place-order
// (cart read + UTR insert + order create + N stock decrements + loyalty + cart
// clear + activity) under concurrent storm load on SQLite. Prisma's stock
// defaults of maxWait=2s + timeout=5s starve under 10+ parallel writers; we
// bump to give SQLite room to serialise without surfacing opaque 500s.
//
// Endpoints that need different windows pass an explicit `{ maxWait, timeout }`
// to `prisma.$transaction()`.
export const prisma =
  global.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    transactionOptions: { maxWait: 15_000, timeout: 30_000 },
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma__ = prisma;
}

// ── Background Jobs (Item 7) ────────────────────────────────────────────
// Start the job runner + scheduler exactly once per Node process.
//
// Why dynamic import + guard here:
//   - db/client.ts is the universal early-import hook (every service
//     and route handler pulls `prisma` from this file).
//   - Dynamic `import()` ensures the entire jobs module tree is never
//     loaded under NODE_ENV=test — preventing timer leaks in test
//     harnesses that import db/client indirectly (spec §3.6).
//   - `JOB_RUNNER_ENABLED=false` opts out (read-only replicas, scripts,
//     ad-hoc tooling that imports prisma).
//
// The startup module is idempotent — calling it more than once
// (Next.js hot reload) is a no-op.
if (process.env.NODE_ENV !== 'test' && process.env.JOB_RUNNER_ENABLED !== 'false') {
  void import('@/lib/jobs/startup')
    .then(({ startJobRunner }) => startJobRunner())
    .catch((e: Error) => {
      // Dynamic-import failure — log via the structured logger (loaded
      // by everything in this graph already). We deliberately do NOT
      // crash the host process: a missing/broken job system must not
      // take down the storefront.
      void import('@/lib/log').then(({ log }) => {
        log.error('job.runner.import_failed', { error: e.message });
      });
    });
}

// Item 18 — first-boot seed for the HomepageSection + HomepageMetric
//   tables. Idempotent (the seed function checks counts first), so
//   running it on every server start is fine. Fire-and-forget; on
//   failure we log and continue — a missing seed means an empty
//   homepage that falls back to the legacy layout.
if (process.env.NODE_ENV !== 'test' && process.env.JOB_RUNNER_ENABLED !== 'false') {
  void import('@/lib/cms/homepage')
    .then(({ seedDefaultsIfEmpty }) => seedDefaultsIfEmpty())
    .catch((e: Error) => {
      void import('@/lib/log').then(({ log }) => {
        log.warn('homepage.seed_failed', { error: e.message });
      });
    });
}
