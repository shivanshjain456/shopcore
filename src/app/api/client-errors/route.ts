/**
 * POST /api/client-errors — beacon endpoint for client-side error
 * reports from <ErrorBoundary>, `error.tsx`, `global-error.tsx`.
 *
 * Best-effort: we accept any JSON shape, log structurally, and always
 * return 204. The client never blocks on this — calls use
 * `keepalive: true` and fire-and-forget. We intentionally do NOT
 * require CSRF here (the beacon must work even when CSRF cookies are
 * unavailable, e.g. mid-logout); we DO rate-limit per IP to prevent
 * abuse.
 *
 * The body is treated as untrusted. We never echo it back. We log
 * the fields the logger's redactor lets through (no PII keys).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { checkRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

interface ClientErrorReport {
  name?: string;
  message?: string;
  stack?: string;
  digest?: string;
  componentStack?: string;
  path?: string;
  source?: string;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  // Beacon endpoints must NEVER produce a visible 429 — a broken page
  // that throws on every render would create a flood of red-bordered
  // network errors in DevTools and obscure the real bug. We use
  // `checkRateLimit` (no-throw) instead of `applyRateLimit` and
  // silently swallow when the cap is reached.
  const rl = await checkRateLimit('client.error_beacon', req);
  if (!rl.ok) return new NextResponse(null, { status: 204 });

  let body: ClientErrorReport = {};
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === 'object') {
      body = parsed as ClientErrorReport;
    }
  } catch { /* malformed body — log what we can */ }

  log.warn('client.error_report', {
    name: typeof body.name === 'string' ? body.name.slice(0, 200) : undefined,
    message: typeof body.message === 'string' ? body.message.slice(0, 500) : undefined,
    stack: typeof body.stack === 'string' ? body.stack.slice(0, 4000) : undefined,
    componentStack: typeof body.componentStack === 'string' ? body.componentStack.slice(0, 4000) : undefined,
    digest: typeof body.digest === 'string' ? body.digest.slice(0, 100) : undefined,
    path: typeof body.path === 'string' ? body.path.slice(0, 200) : undefined,
    source: typeof body.source === 'string' ? body.source.slice(0, 60) : undefined,
    userAgent: req.headers.get('user-agent')?.slice(0, 200),
  });

  return jsonOk({ received: true });
});
