/**
 * GET /api/health — public liveness probe (always 200 if process is up).
 * Returns minimal info; safe to expose.
 */
import { NextResponse } from 'next/server';

import { withErrorHandling } from '@/lib/api';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  return NextResponse.json({
    ok: true,
    service: 'shopcore',
    time: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});
